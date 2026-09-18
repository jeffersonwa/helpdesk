/**
 * Property 5 — Idempotência de ingestão (tarefa 16.2).
 *
 * **Property 5: Idempotência de ingestão — Validates: Requisitos 5.6, 6.12, 10.2**
 *   Processar a MESMA `InboundMessage` duas vezes cria NO MÁXIMO uma `Message`
 *   e NO MÁXIMO um `Ticket`, e ambas as chamadas retornam o mesmo
 *   `conversationId`/`ticketId`.
 *
 * Este é um teste de INTEGRAÇÃO contra o Postgres de desenvolvimento via túnel
 * (DATABASE_URL em localhost:55432). É guardado com `describe.skip` quando
 * `DATABASE_URL` não está definida (mesmo padrão de `schema.integration.test.ts`).
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { ChannelType, MessageType } from "@/lib/domain/enums";
import type { InboundMessage } from "@/lib/domain/types";
import { route, type RouterPrisma } from "@/lib/ingestion/router";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const prisma = DATABASE_URL
  ? new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    })
  : (null as unknown as PrismaClient);

const RUN = `ing-prop-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DB_TIMEOUT_MS = 60_000;

const created: { companyId?: string; userId?: string } = {};

describeIf("IngestionRouter — Property 5 (idempotência)", () => {
  afterAll(async () => {
    if (!DATABASE_URL) return;
    const companyId = created.companyId;
    if (companyId) {
      await prisma.ticketEvent.deleteMany({ where: { companyId } });
      await prisma.outboxEvent.deleteMany({ where: { companyId } });
      await prisma.ticket.deleteMany({ where: { companyId } });
      await prisma.ticketSequence.deleteMany({ where: { companyId } });
      await prisma.message.deleteMany({ where: { companyId } });
      await prisma.conversation.deleteMany({ where: { companyId } });
      await prisma.channelAccount.deleteMany({ where: { companyId } });
      await prisma.queue.deleteMany({ where: { companyId } });
      if (created.userId) {
        await prisma.user.deleteMany({ where: { id: created.userId } });
      }
      await prisma.company.deleteMany({ where: { id: companyId } });
    }
    await prisma.$disconnect();
  }, DB_TIMEOUT_MS);

  it(
    "processar a mesma InboundMessage duas vezes cria no máximo 1 Message e 1 Ticket",
    async () => {
      // Fixtures: Company + User (criador de sistema) + Queue padrão + conta.
      const company = await prisma.company.create({
        data: { name: `Co ${RUN}`, slug: `co-${RUN}` },
      });
      created.companyId = company.id;

      const user = await prisma.user.create({
        data: {
          name: "System",
          email: `sys-${RUN}@example.test`,
          password: "x",
          role: "AGENT",
          companyId: company.id,
        },
      });
      created.userId = user.id;

      await prisma.queue.create({
        data: { companyId: company.id, name: "Default", isDefault: true },
      });

      const account = await prisma.channelAccount.create({
        data: {
          companyId: company.id,
          type: ChannelType.WHATSAPP,
          provider: "WHATSAPP_MOCK",
          label: "Mock WA",
          secretRef: "env:WA_SECRET_REF",
        },
      });

      const externalId = `wamid-${RUN}`;
      const msg: InboundMessage = {
        companyId: company.id,
        channelAccountId: account.id,
        contactExternalId: "+5511970000000",
        contactName: "Cliente",
        type: MessageType.TEXT,
        body: "Olá, preciso de ajuda",
        externalId,
        timestamp: new Date("2026-06-01T10:00:00.000Z"),
      };

      const deps = { prisma: prisma as unknown as RouterPrisma };

      // Processa a MESMA mensagem duas vezes.
      const first = await route(msg, deps);
      const second = await route(msg, deps);

      // Ambas as chamadas retornam o mesmo vínculo.
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.ticketId).toBe(first.ticketId);

      // No máximo UMA Message com aquele externalId.
      const messageCount = await prisma.message.count({
        where: { companyId: company.id, externalId },
      });
      expect(messageCount).toBe(1);

      // No máximo UM Ticket vinculado àquela conversa.
      const ticketCount = await prisma.ticket.count({
        where: {
          companyId: company.id,
          conversationId: first.conversationId,
        },
      });
      expect(ticketCount).toBe(1);

      // Uma única Conversation para o par (contato, canal).
      const conversationCount = await prisma.conversation.count({
        where: {
          companyId: company.id,
          channelAccountId: account.id,
          contactExternalId: msg.contactExternalId,
        },
      });
      expect(conversationCount).toBe(1);
    },
    DB_TIMEOUT_MS,
  );
});
