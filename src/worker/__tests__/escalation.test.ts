/**
 * Testes unitários do worker de escalonamento (tarefa 23.3) — prisma mockado +
 * motor puro real (`selectEscalations`).
 *
 * Cobrem:
 *  - Uma regra dispara UMA vez por gatilho: a 1ª varredura escala e grava
 *    `EscalationLog`; a 2ª varredura NÃO re-escala porque `escalatedTriggers`
 *    (derivado dos logs) agora inclui o gatilho (idempotência — Req. 12.5).
 *  - Reatribuição aplicada (assignedToId / teamId).
 *  - `OutboxEvent` de notificação enfileirado no mesmo tx.
 *
 * A idempotência é do motor puro (`jaEscalado` sobre `snapshot.escalatedTriggers`),
 * e o worker alimenta esse campo a partir dos `EscalationLog` persistidos — este
 * teste exercita exatamente esse acoplamento com um fake prisma in-memory.
 *
 * _Requisitos: 12.4, 12.5_
 */

import { describe, expect, it, vi } from "vitest";
import { EscalationTrigger, TicketStatus } from "@/lib/domain/enums";
import {
  runEscalationSweepOnce,
  type EscalationPrisma,
} from "@/worker/escalation";

/** Estado in-memory de um ticket ativo. */
interface TicketRow {
  id: string;
  companyId: string;
  status: string;
  assignedToId: string | null;
  teamId: string | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  slaResponseDeadline: Date | null;
  slaResolutionDeadline: Date | null;
  updatedAt: Date;
}

interface RuleRow {
  id: string;
  companyId: string;
  trigger: EscalationTrigger;
  afterMin: number;
  active: boolean;
  toUserId: string | null;
  toTeamId: string | null;
}

interface LogRow {
  companyId: string;
  ticketId: string;
  trigger: EscalationTrigger;
}

interface OutboxRow {
  companyId: string;
  type: string;
  payload: unknown;
  state: string;
  attempts: number;
  nextRunAt: Date;
}

/**
 * Fake prisma cobrindo o que `runEscalationSweepOnce` usa: `ticket.findMany`
 * (com `escalations` derivadas dos logs), `ticket.update`, `escalationRule.findMany`,
 * `escalationLog.create`, `outboxEvent.create` e `$transaction`.
 */
function makeFakePrisma(opts: {
  tickets: TicketRow[];
  rules: RuleRow[];
}) {
  const tickets = opts.tickets.map((t) => ({ ...t }));
  const rules = opts.rules.map((r) => ({ ...r }));
  const logs: LogRow[] = [];
  const outbox: OutboxRow[] = [];

  const models = {
    ticket: {
      async findMany(args: {
        where: { status: { notIn: readonly string[] } };
        take?: number;
        select: Record<string, unknown>;
      }) {
        const inactive = new Set(args.where.status.notIn);
        return tickets
          .filter((t) => !inactive.has(t.status))
          .map((t) => ({
            id: t.id,
            companyId: t.companyId,
            assignedToId: t.assignedToId,
            teamId: t.teamId,
            firstResponseAt: t.firstResponseAt,
            resolvedAt: t.resolvedAt,
            slaResponseDeadline: t.slaResponseDeadline,
            slaResolutionDeadline: t.slaResolutionDeadline,
            updatedAt: t.updatedAt,
            // escalatedTriggers derivam dos logs já persistidos.
            escalations: logs
              .filter((l) => l.ticketId === t.id)
              .map((l) => ({ trigger: l.trigger })),
          }));
      },
      async update(args: {
        where: { id: string };
        data: { assignedToId?: string; teamId?: string };
      }) {
        const t = tickets.find((x) => x.id === args.where.id);
        if (!t) throw new Error("ticket not found");
        if (args.data.assignedToId !== undefined)
          t.assignedToId = args.data.assignedToId;
        if (args.data.teamId !== undefined) t.teamId = args.data.teamId;
        return { ...t };
      },
    },
    escalationRule: {
      async findMany(args: {
        where: { companyId: string; active: boolean };
      }) {
        return rules.filter(
          (r) => r.companyId === args.where.companyId && r.active,
        );
      },
    },
    escalationLog: {
      async create(args: { data: LogRow }) {
        logs.push({ ...args.data });
        return { ...args.data };
      },
    },
    outboxEvent: {
      async create(args: { data: OutboxRow }) {
        outbox.push({ ...args.data });
        return { id: `ox-${outbox.length}` };
      },
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      // Tx compartilha os mesmos delegates (in-memory; sem rollback real).
      return fn(models);
    },
  };

  const prisma = models as unknown as EscalationPrisma;
  return { prisma, tickets, logs, outbox };
}

const NOW = new Date("2025-01-01T12:00:00.000Z");
// Deadline no passado por >30min: RESPONSE_BREACH satisfeito.
const PAST_DEADLINE = new Date(NOW.getTime() - 60 * 60_000);

function activeTicket(over: Partial<TicketRow> = {}): TicketRow {
  return {
    id: over.id ?? "t-1",
    companyId: over.companyId ?? "co-1",
    status: over.status ?? TicketStatus.OPEN,
    assignedToId: over.assignedToId ?? null,
    teamId: over.teamId ?? null,
    firstResponseAt: over.firstResponseAt ?? null,
    resolvedAt: over.resolvedAt ?? null,
    slaResponseDeadline: over.slaResponseDeadline ?? PAST_DEADLINE,
    slaResolutionDeadline: over.slaResolutionDeadline ?? null,
    updatedAt: over.updatedAt ?? NOW,
  };
}

function responseRule(over: Partial<RuleRow> = {}): RuleRow {
  return {
    id: over.id ?? "r-1",
    companyId: over.companyId ?? "co-1",
    trigger: over.trigger ?? EscalationTrigger.RESPONSE_BREACH,
    afterMin: over.afterMin ?? 30,
    active: over.active ?? true,
    toUserId: "toUserId" in over ? (over.toUserId ?? null) : "u-boss",
    toTeamId: over.toTeamId ?? null,
  };
}

describe("runEscalationSweepOnce", () => {
  it("escala uma vez, grava EscalationLog, reatribui e enfileira outbox", async () => {
    const { prisma, tickets, logs, outbox } = makeFakePrisma({
      tickets: [activeTicket()],
      rules: [responseRule({ toUserId: "u-boss" })],
    });

    const res = await runEscalationSweepOnce({ prisma, now: () => NOW });

    expect(res).toEqual({ ticketsScanned: 1, escalationsApplied: 1 });
    // EscalationLog gravado com o gatilho.
    expect(logs).toEqual([
      { companyId: "co-1", ticketId: "t-1", trigger: EscalationTrigger.RESPONSE_BREACH },
    ]);
    // Reatribuição aplicada.
    expect(tickets[0].assignedToId).toBe("u-boss");
    // Outbox enfileirado no mesmo tx.
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      companyId: "co-1",
      type: "webhook.dispatch",
      state: "PENDING",
      attempts: 0,
    });
    expect(outbox[0].payload).toMatchObject({
      event: "ticket.escalated",
      ticketId: "t-1",
      trigger: EscalationTrigger.RESPONSE_BREACH,
    });
  });

  it("aplica reatribuição de time quando a regra define toTeamId", async () => {
    const { prisma, tickets } = makeFakePrisma({
      tickets: [activeTicket()],
      rules: [responseRule({ toUserId: null, toTeamId: "team-2" })],
    });

    await runEscalationSweepOnce({ prisma, now: () => NOW });

    expect(tickets[0].teamId).toBe("team-2");
    expect(tickets[0].assignedToId).toBeNull();
  });

  it("NÃO re-escala o mesmo gatilho numa segunda varredura (idempotência)", async () => {
    const { prisma, logs, outbox } = makeFakePrisma({
      tickets: [activeTicket()],
      rules: [responseRule()],
    });

    const first = await runEscalationSweepOnce({ prisma, now: () => NOW });
    const second = await runEscalationSweepOnce({ prisma, now: () => NOW });

    expect(first.escalationsApplied).toBe(1);
    // Segunda varredura: escalatedTriggers agora inclui RESPONSE_BREACH → nada.
    expect(second.escalationsApplied).toBe(0);
    expect(logs).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  it("ignora tickets sem regras ativas do tenant", async () => {
    const { prisma, logs, outbox } = makeFakePrisma({
      tickets: [activeTicket()],
      rules: [responseRule({ active: false })],
    });

    const res = await runEscalationSweepOnce({ prisma, now: () => NOW });

    expect(res.escalationsApplied).toBe(0);
    expect(logs).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });
});
