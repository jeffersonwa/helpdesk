/**
 * SLA/escalation worker — varredura periódica de escalonamento (tarefa 23.2).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Motor de escalonamento" — diagrama Worker→SlaEngine→EscalationEngine→
 * DB/Outbox) e requirements 12.4, 12.5.
 *
 * Fluxo de `runEscalationSweepOnce`:
 *  1. Carrega os tickets ATIVOS (status ∉ {RESOLVED, CLOSED, CANCELLED}) de todos
 *     os tenants, junto de suas `EscalationLog` (gatilhos já aplicados).
 *  2. Carrega as `EscalationRule` ativas por tenant (uma vez por tenant).
 *  3. Para cada ticket monta um `TicketSnapshot` cujo `escalatedTriggers` vem dos
 *     `EscalationLog` existentes — assim o predicado de idempotência do motor puro
 *     (`jaEscalado`) NÃO reescalona um gatilho já registrado (Req. 12.5).
 *  4. Chama `selectEscalations(snapshot, rules, now)` (motor puro).
 *  5. Para cada regra selecionada, dentro de UMA transação:
 *       a. cria um `EscalationLog` (registra o gatilho → idempotência futura);
 *       b. reatribui o ticket (`assignedToId = rule.toUserId` e/ou
 *          `teamId = rule.toTeamId`, quando presentes);
 *       c. enfileira um `OutboxEvent` de notificação no MESMO tx (via dispatcher).
 *
 * O intervalo (≤5 min, Req. 12.4) pertence ao scheduler (o entrypoint do worker);
 * aqui expomos apenas a execução de UMA varredura, injetando `prisma` e `now`.
 *
 * _Requisitos: 12.4, 12.5_
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { EscalationTrigger, TicketStatus } from "@/lib/domain/enums";
import type { TicketSnapshot } from "@/lib/domain/types";
import {
  selectEscalations,
  type EscalationRuleInput,
} from "@/lib/engines/escalation";
import { enqueue, type OutboxCapableClient } from "@/lib/outbox/dispatcher";
import { prisma as defaultPrisma } from "@/lib/prisma";

/** Status inativos: uma nova mensagem/varredura não escala esses tickets. */
const INACTIVE_TICKET_STATUSES = [
  TicketStatus.RESOLVED,
  TicketStatus.CLOSED,
  TicketStatus.CANCELLED,
] as const;

/** Tipo de evento de outbox emitido ao escalar (notificação webhook/e-mail). */
const ESCALATION_OUTBOX_TYPE = "webhook.dispatch";

/** Client Prisma mínimo do qual o worker de escalonamento depende. */
export type EscalationPrisma = Pick<
  PrismaClient,
  "ticket" | "escalationRule" | "$transaction"
>;

/** Dependências injetáveis de {@link runEscalationSweepOnce}. */
export interface EscalationSweepDeps {
  prisma?: EscalationPrisma;
  now?: () => Date;
  /** Limite de tickets ativos processados por varredura. */
  batchSize?: number;
}

/** Resumo de uma varredura. */
export interface EscalationSweepResult {
  ticketsScanned: number;
  escalationsApplied: number;
}

/** Linha de ticket ativo lida do banco (com os logs de escalonamento). */
interface ActiveTicketRow {
  id: string;
  companyId: string;
  assignedToId: string | null;
  teamId: string | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  slaResponseDeadline: Date | null;
  slaResolutionDeadline: Date | null;
  updatedAt: Date;
  escalations: { trigger: EscalationTrigger }[];
}

/**
 * Monta o `TicketSnapshot` puro a partir de uma linha de ticket, derivando
 * `escalatedTriggers` dos `EscalationLog` já persistidos (idempotência).
 */
function toSnapshot(row: ActiveTicketRow): TicketSnapshot {
  return {
    id: row.id,
    companyId: row.companyId,
    firstResponseAt: row.firstResponseAt,
    resolvedAt: row.resolvedAt,
    slaResponseDeadline: row.slaResponseDeadline,
    slaResolutionDeadline: row.slaResolutionDeadline,
    updatedAt: row.updatedAt,
    escalatedTriggers: row.escalations.map((e) => e.trigger),
  };
}

/**
 * Executa UMA varredura de escalonamento sobre todos os tickets ativos.
 *
 * @returns contagem de tickets varridos e escalonamentos aplicados.
 */
export async function runEscalationSweepOnce(
  deps: EscalationSweepDeps = {},
): Promise<EscalationSweepResult> {
  const prisma = deps.prisma ?? (defaultPrisma as unknown as EscalationPrisma);
  const now = deps.now ?? (() => new Date());
  const currentNow = now();

  const tickets = (await prisma.ticket.findMany({
    where: { status: { notIn: INACTIVE_TICKET_STATUSES as never } },
    take: deps.batchSize,
    select: {
      id: true,
      companyId: true,
      assignedToId: true,
      teamId: true,
      firstResponseAt: true,
      resolvedAt: true,
      slaResponseDeadline: true,
      slaResolutionDeadline: true,
      updatedAt: true,
      escalations: { select: { trigger: true } },
    },
  })) as ActiveTicketRow[];

  const result: EscalationSweepResult = {
    ticketsScanned: tickets.length,
    escalationsApplied: 0,
  };

  // Cache de regras por tenant (evita reconsultar por ticket do mesmo tenant).
  const rulesByCompany = new Map<string, EscalationRuleInput[]>();

  for (const row of tickets) {
    let rules = rulesByCompany.get(row.companyId);
    if (!rules) {
      const dbRules = await prisma.escalationRule.findMany({
        where: { companyId: row.companyId, active: true },
        select: {
          id: true,
          trigger: true,
          afterMin: true,
          active: true,
          toUserId: true,
          toTeamId: true,
        },
      });
      rules = dbRules as EscalationRuleInput[];
      rulesByCompany.set(row.companyId, rules);
    }
    if (rules.length === 0) continue;

    const snapshot = toSnapshot(row);
    const selected = selectEscalations(snapshot, rules, currentNow);
    if (selected.length === 0) continue;

    for (const rule of selected) {
      // Cada regra aplicada é atômica: log + reatribuição + outbox no MESMO tx.
      await prisma.$transaction(async (tx) => {
        const txClient = tx as unknown as {
          escalationLog: {
            create(args: { data: Prisma.EscalationLogUncheckedCreateInput }): Promise<unknown>;
          };
          ticket: {
            update(args: {
              where: { id: string };
              data: Prisma.TicketUncheckedUpdateInput;
            }): Promise<unknown>;
          };
        } & OutboxCapableClient;

        // (a) Registrar o gatilho (idempotência das próximas varreduras).
        await txClient.escalationLog.create({
          data: {
            companyId: row.companyId,
            ticketId: row.id,
            trigger: rule.trigger,
          },
        });

        // (b) Reatribuir o ticket conforme a regra (usuário e/ou time).
        const data: Prisma.TicketUncheckedUpdateInput = {};
        if (rule.toUserId) data.assignedToId = rule.toUserId;
        if (rule.toTeamId) data.teamId = rule.toTeamId;
        if (Object.keys(data).length > 0) {
          await txClient.ticket.update({ where: { id: row.id }, data });
        }

        // (c) Enfileirar a notificação no outbox (mesmo tx).
        await enqueue(
          txClient,
          {
            companyId: row.companyId,
            type: ESCALATION_OUTBOX_TYPE,
            payload: {
              event: "ticket.escalated",
              ticketId: row.id,
              companyId: row.companyId,
              trigger: rule.trigger,
              ruleId: rule.id,
              toUserId: rule.toUserId ?? null,
              toTeamId: rule.toTeamId ?? null,
            },
          },
          now,
        );
      });

      result.escalationsApplied += 1;
    }
  }

  return result;
}
