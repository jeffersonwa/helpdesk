/**
 * Teste de INTEGRAÇÃO do TicketService (tarefa 10.3) — caminho feliz
 * create + número sequencial + SLA, contra o banco de desenvolvimento REAL
 * via túnel SSH (DATABASE_URL em localhost:55432).
 *
 * Guardado por `DATABASE_URL` (describe.skip quando ausente), mesmo padrão de
 * `sequence.property.test.ts`. Cria fixtures mínimas descartáveis (Company +
 * User + SlaRule), cria um ticket via `createTicket` e valida número, status
 * OPEN, prioridade derivada e prazos de SLA. Também valida o caminho SEM
 * SlaRule. Limpa tudo no `afterAll`.
 *
 * _Requisitos: 4.3, 4.5, 4.7, 12.1, 12.10_
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { Impact, Priority, Role, ScopeLevel, Urgency } from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import { createTicket, type TicketPrisma } from "@/lib/tickets/service";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const DB_TIMEOUT_MS = 60_000;

const prisma = DATABASE_URL
  ? new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10 }),
    })
  : (null as unknown as PrismaClient);

const RUN = `tksvc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: { companyId?: string; userId?: string } = {};

function tenantUser(companyId: string, userId: string): SessionUser {
  return {
    id: userId,
    companyId,
    role: Role.AGENT,
    roleAssignments: [
      {
        permissions: ["ticket.create", "ticket.update"],
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
    ],
  };
}

describeIf("TicketService (integração DB) — create + número + SLA", () => {
  afterAll(async () => {
    if (!DATABASE_URL) return;
    const companyId = created.companyId;
    if (companyId) {
      await prisma.ticket.deleteMany({ where: { companyId } });
      await prisma.ticketSequence.deleteMany({ where: { companyId } });
      await prisma.slaRule.deleteMany({ where: { companyId } });
      if (created.userId) {
        await prisma.user.deleteMany({ where: { id: created.userId } });
      }
      await prisma.company.deleteMany({ where: { id: companyId } });
    }
    await prisma.$disconnect();
  }, DB_TIMEOUT_MS);

  it(
    "cria ticket com número sequencial, status OPEN, prioridade derivada e prazos de SLA",
    async () => {
      const company = await prisma.company.create({
        data: { name: `Co ${RUN}`, slug: `co-${RUN}` },
      });
      created.companyId = company.id;

      const user = await prisma.user.create({
        data: {
          name: "Creator",
          email: `creator-${RUN}@example.test`,
          password: "x",
          role: "AGENT",
          companyId: company.id,
        },
      });
      created.userId = user.id;

      // SlaRule para HIGH (impacto HIGH × urgência MEDIUM → HIGH).
      await prisma.slaRule.create({
        data: {
          companyId: company.id,
          priority: Priority.HIGH,
          responseHours: 4,
          resolutionHours: 8,
        },
      });

      const sessionUser = tenantUser(company.id, user.id);

      const res = await createTicket(
        sessionUser,
        company.id,
        {
          title: "Servidor fora do ar",
          description: "Produção indisponível.",
          createdById: user.id,
          impact: Impact.HIGH,
          urgency: Urgency.MEDIUM,
        },
        { prisma: prisma as unknown as TicketPrisma },
      );

      expect(res.number).toBeGreaterThanOrEqual(1);
      expect(res.status).toBe("OPEN");
      expect(res.priority).toBe(Priority.HIGH);
      expect(res.slaRuleMissing).toBe(false);
      expect(res.slaResponseDeadline).toBeInstanceOf(Date);
      expect(res.slaResolutionDeadline).toBeInstanceOf(Date);

      // Confirma persistência real.
      const persisted = await prisma.ticket.findUnique({
        where: { id: res.ticketId },
        select: {
          number: true,
          status: true,
          priority: true,
          slaResponseDeadline: true,
          slaResolutionDeadline: true,
          companyId: true,
        },
      });
      expect(persisted?.companyId).toBe(company.id);
      expect(persisted?.status).toBe("OPEN");
      expect(persisted?.priority).toBe("HIGH");
      expect(persisted?.slaResponseDeadline).not.toBeNull();
    },
    DB_TIMEOUT_MS,
  );

  it(
    "cria ticket SEM prazos quando não há SlaRule para a prioridade (Req. 12.10)",
    async () => {
      const companyId = created.companyId!;
      const userId = created.userId!;
      const sessionUser = tenantUser(companyId, userId);

      // impacto LOW × urgência LOW → LOW; não criamos SlaRule para LOW.
      const res = await createTicket(
        sessionUser,
        companyId,
        {
          title: "Dúvida simples",
          description: "Como troco minha senha?",
          createdById: userId,
          impact: Impact.LOW,
          urgency: Urgency.LOW,
        },
        { prisma: prisma as unknown as TicketPrisma },
      );

      expect(res.priority).toBe(Priority.LOW);
      expect(res.slaRuleMissing).toBe(true);
      expect(res.slaResponseDeadline).toBeNull();
      expect(res.slaResolutionDeadline).toBeNull();

      const persisted = await prisma.ticket.findUnique({
        where: { id: res.ticketId },
        select: { slaResponseDeadline: true, slaResolutionDeadline: true },
      });
      expect(persisted?.slaResponseDeadline).toBeNull();
      expect(persisted?.slaResolutionDeadline).toBeNull();
    },
    DB_TIMEOUT_MS,
  );
});
