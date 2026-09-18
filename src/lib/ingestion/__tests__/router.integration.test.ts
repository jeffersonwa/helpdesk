/**
 * Testes de integração de roteamento do IngestionRouter (tarefa 16.3).
 *
 * DB-guarded: só rodam quando `DATABASE_URL` está definida (Postgres de dev via
 * túnel em localhost:55432); caso contrário, `describe.skip`.
 *
 * Cobrem:
 *  - Divergência de tenant rejeitada (account.companyId ≠ msg.companyId) — Req. 1.6;
 *  - `ChannelAccount` não resolvida → descarte (sem Message/Ticket) — Req. 5.5;
 *  - canal desconhecido → descarte — Req. 10.8;
 *  - ticket ativo reaproveitado vs. novo ticket: duas mensagens na mesma conversa
 *    anexam ao MESMO ticket; após resolver o ticket, uma terceira mensagem cria
 *    um NOVO ticket — Req. 10.4, 10.5.
 *
 * _Requisitos: 1.6, 5.5, 10.4, 10.5, 10.8_
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ChannelType, MessageType, TicketStatus } from "@/lib/domain/enums";
import type { InboundMessage } from "@/lib/domain/types";
import {
  IngestionError,
  route,
  type RouterPrisma,
} from "@/lib/ingestion/router";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const prisma = DATABASE_URL
  ? new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    })
  : (null as unknown as PrismaClient);

const RUN = `ing-int-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DB_TIMEOUT_MS = 60_000;

// Dois tenants para testar divergência de tenant e isolamento.
const created: {
  companyAId?: string;
  companyBId?: string;
  userAId?: string;
  userBId?: string;
} = {};

const deps = { prisma: prisma as unknown as RouterPrisma };

describeIf("IngestionRouter — integração de roteamento", () => {
  afterAll(async () => {
    if (!DATABASE_URL) return;
    for (const companyId of [created.companyAId, created.companyBId]) {
      if (!companyId) continue;
      await prisma.ticketEvent.deleteMany({ where: { companyId } });
      await prisma.outboxEvent.deleteMany({ where: { companyId } });
      await prisma.ticket.deleteMany({ where: { companyId } });
      await prisma.ticketSequence.deleteMany({ where: { companyId } });
      await prisma.message.deleteMany({ where: { companyId } });
      await prisma.conversation.deleteMany({ where: { companyId } });
      await prisma.channelAccount.deleteMany({ where: { companyId } });
      await prisma.queue.deleteMany({ where: { companyId } });
      await prisma.user.deleteMany({ where: { companyId } });
      await prisma.company.deleteMany({ where: { id: companyId } });
    }
    await prisma.$disconnect();
  }, DB_TIMEOUT_MS);

  it(
    "rejeita divergência de tenant (account.companyId ≠ msg.companyId) sem persistir",
    async () => {
      const companyA = await prisma.company.create({
        data: { name: `A ${RUN}`, slug: `a-${RUN}` },
      });
      created.companyAId = companyA.id;
      const companyB = await prisma.company.create({
        data: { name: `B ${RUN}`, slug: `b-${RUN}` },
      });
      created.companyBId = companyB.id;

      const userA = await prisma.user.create({
        data: {
          name: "SysA",
          email: `sysa-${RUN}@example.test`,
          password: "x",
          role: "AGENT",
          companyId: companyA.id,
        },
      });
      created.userAId = userA.id;
      const userB = await prisma.user.create({
        data: {
          name: "SysB",
          email: `sysb-${RUN}@example.test`,
          password: "x",
          role: "AGENT",
          companyId: companyB.id,
        },
      });
      created.userBId = userB.id;

      // Conta pertence ao tenant A.
      const accountA = await prisma.channelAccount.create({
        data: {
          companyId: companyA.id,
          type: ChannelType.WHATSAPP,
          provider: "WHATSAPP_MOCK",
          label: "WA A",
          secretRef: "env:WA_A",
        },
      });

      // Mensagem alega pertencer ao tenant B — divergência.
      const msg: InboundMessage = {
        companyId: companyB.id,
        channelAccountId: accountA.id,
        contactExternalId: "+5511900000001",
        type: MessageType.TEXT,
        body: "spoof",
        externalId: `spoof-${RUN}`,
        timestamp: new Date("2026-06-01T10:00:00.000Z"),
      };

      await expect(route(msg, deps)).rejects.toBeInstanceOf(IngestionError);
      await expect(route(msg, deps)).rejects.toMatchObject({
        reason: "TENANT_MISMATCH",
      });

      // Nada persistido em nenhum dos tenants para aquele externalId.
      const msgCount = await prisma.message.count({
        where: { externalId: `spoof-${RUN}` },
      });
      expect(msgCount).toBe(0);
    },
    DB_TIMEOUT_MS,
  );

  it(
    "descarta quando a ChannelAccount não é resolvida (sem Message/Ticket)",
    async () => {
      const msg: InboundMessage = {
        companyId: created.companyAId!,
        channelAccountId: "acc-inexistente-xyz",
        contactExternalId: "+5511900000002",
        type: MessageType.TEXT,
        body: "hi",
        externalId: `noacc-${RUN}`,
        timestamp: new Date("2026-06-01T10:00:00.000Z"),
      };

      await expect(route(msg, deps)).rejects.toMatchObject({
        reason: "ACCOUNT_NOT_RESOLVED",
      });

      const msgCount = await prisma.message.count({
        where: { externalId: `noacc-${RUN}` },
      });
      expect(msgCount).toBe(0);
    },
    DB_TIMEOUT_MS,
  );

  it(
    "descarta canal desconhecido (tipo fora do enum) sem Message/Ticket",
    async () => {
      // Um `ChannelType` fora do enum não pode ser persistido no banco (coluna
      // enum), então exercitamos o guard UNKNOWN_CHANNEL com um prisma mockado
      // que devolve uma conta com `type` desconhecido. Nenhum efeito é criado.
      const create = vi.fn();
      const mockPrisma = {
        channelAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "acc-x",
            companyId: created.companyAId!,
            type: "TELEGRAM", // não pertence a ChannelType
            active: true,
          }),
        },
        message: { findUnique: vi.fn(), create },
        queue: { findFirst: vi.fn() },
        user: { findFirst: vi.fn() },
        $transaction: vi.fn(),
      } as unknown as RouterPrisma;

      const msg: InboundMessage = {
        companyId: created.companyAId!,
        channelAccountId: "acc-x",
        contactExternalId: "+5511900000009",
        type: MessageType.TEXT,
        body: "hi",
        externalId: `unknown-${RUN}`,
        timestamp: new Date("2026-06-01T10:00:00.000Z"),
      };

      await expect(route(msg, { prisma: mockPrisma })).rejects.toMatchObject({
        reason: "UNKNOWN_CHANNEL",
      });
      expect(create).not.toHaveBeenCalled();
    },
    DB_TIMEOUT_MS,
  );

  it(
    "reaproveita ticket ativo e cria novo após resolução",
    async () => {
      const companyId = created.companyAId!;

      await prisma.queue.create({
        data: { companyId, name: `Q ${RUN}`, isDefault: true },
      });

      const account = await prisma.channelAccount.create({
        data: {
          companyId,
          type: ChannelType.WHATSAPP,
          provider: "WHATSAPP_MOCK",
          label: "WA reuse",
          secretRef: "env:WA_REUSE",
        },
      });

      const contact = "+5511900000003";
      const base = {
        companyId,
        channelAccountId: account.id,
        contactExternalId: contact,
        type: MessageType.TEXT,
      } as const;

      const first = await route(
        {
          ...base,
          body: "primeira",
          externalId: `reuse1-${RUN}`,
          timestamp: new Date("2026-06-01T10:00:00.000Z"),
        },
        deps,
      );
      const second = await route(
        {
          ...base,
          body: "segunda",
          externalId: `reuse2-${RUN}`,
          timestamp: new Date("2026-06-01T10:05:00.000Z"),
        },
        deps,
      );

      // Segunda mensagem anexa ao MESMO ticket ativo (Req. 10.5).
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.ticketId).toBe(first.ticketId);
      expect(first.ticketId).toBeTruthy();

      // Só um ticket até aqui na conversa.
      const countBefore = await prisma.ticket.count({
        where: { companyId, conversationId: first.conversationId },
      });
      expect(countBefore).toBe(1);

      // Resolve o ticket → ele deixa de ser ativo.
      await prisma.ticket.update({
        where: { id: first.ticketId! },
        data: { status: TicketStatus.RESOLVED },
      });

      // Terceira mensagem cria um NOVO ticket na mesma conversa (Req. 10.4).
      const third = await route(
        {
          ...base,
          body: "terceira",
          externalId: `reuse3-${RUN}`,
          timestamp: new Date("2026-06-01T11:00:00.000Z"),
        },
        deps,
      );

      expect(third.conversationId).toBe(first.conversationId);
      expect(third.ticketId).toBeTruthy();
      expect(third.ticketId).not.toBe(first.ticketId);

      const countAfter = await prisma.ticket.count({
        where: { companyId, conversationId: first.conversationId },
      });
      expect(countAfter).toBe(2);
    },
    DB_TIMEOUT_MS,
  );
});
