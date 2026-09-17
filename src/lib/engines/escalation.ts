/**
 * EscalationEngine — núcleo puro.
 *
 * Seleciona quais `EscalationRule` devem disparar para um ticket num dado
 * instante, conforme o pseudocódigo do design
 * (`.kiro/specs/helpdesk-omnichannel/design.md`, seção
 * "Pseudocódigo — seleção de escalonamento").
 *
 * A função é pura, determinística e sem I/O: opera sobre um `TicketSnapshot`
 * e uma lista de regras em memória. O worker de escalonamento adapta as linhas
 * do Prisma (`EscalationRule`) para `EscalationRuleInput` antes de invocá-la.
 *
 * _Requisitos: 12.4, 12.5_
 */

import { EscalationTrigger } from "@/lib/domain/enums";
import type { TicketSnapshot } from "@/lib/domain/types";

/**
 * Forma plana de uma regra de escalonamento consumida pelo motor puro.
 *
 * O modelo persistido vive no Prisma (`model EscalationRule`); esta interface
 * é o contrato mínimo de entrada, para que o motor não dependa do client
 * gerado. O worker adapta cada linha do banco a este formato.
 */
export interface EscalationRuleInput {
  id: string;
  trigger: EscalationTrigger;
  /** Minutos após o gatilho (deadline/inatividade) para a regra disparar. */
  afterMin: number;
  active: boolean;
  toUserId?: string | null;
  toTeamId?: string | null;
}

const MINUTE_MS = 60_000;

/**
 * Predicado de idempotência: a regra já foi escalada para este gatilho?
 *
 * Baseia-se em `ticket.escalatedTriggers`, que registra os gatilhos já
 * aplicados (persistidos via `EscalationLog`).
 */
export function jaEscalado(
  ticket: TicketSnapshot,
  trigger: EscalationTrigger
): boolean {
  return ticket.escalatedTriggers.includes(trigger);
}

/**
 * Seleciona as regras que devem disparar para o ticket no instante `now`.
 *
 * Segue exatamente o pseudocódigo do design:
 * - regras inativas são ignoradas;
 * - cada gatilho tem sua condição específica (com guarda para deadlines nulos);
 * - `MANUAL` nunca dispara automaticamente;
 * - só inclui a regra se o gatilho ocorreu E ainda não foi escalado.
 *
 * @returns o subconjunto das `rules` de entrada que deve disparar.
 */
export function selectEscalations(
  ticket: TicketSnapshot,
  rules: EscalationRuleInput[],
  now: Date
): EscalationRuleInput[] {
  const aplicaveis: EscalationRuleInput[] = [];

  for (const r of rules) {
    if (!r.active) continue;

    let gatilhoOk = false;

    switch (r.trigger) {
      case EscalationTrigger.RESPONSE_BREACH:
        gatilhoOk =
          ticket.firstResponseAt === null &&
          ticket.slaResponseDeadline !== null &&
          now.getTime() >=
            ticket.slaResponseDeadline.getTime() + r.afterMin * MINUTE_MS;
        break;

      case EscalationTrigger.RESOLUTION_BREACH:
        gatilhoOk =
          ticket.resolvedAt === null &&
          ticket.slaResolutionDeadline !== null &&
          now.getTime() >=
            ticket.slaResolutionDeadline.getTime() + r.afterMin * MINUTE_MS;
        break;

      case EscalationTrigger.INACTIVITY:
        gatilhoOk =
          now.getTime() >= ticket.updatedAt.getTime() + r.afterMin * MINUTE_MS;
        break;

      case EscalationTrigger.MANUAL:
        // Escalonamentos manuais nunca são selecionados automaticamente.
        gatilhoOk = false;
        break;
    }

    // Idempotência: não repetir escalonamento já registrado.
    if (gatilhoOk && !jaEscalado(ticket, r.trigger)) {
      aplicaveis.push(r);
    }
  }

  return aplicaveis;
}
