/**
 * Testes unitários do EscalationEngine (`selectEscalations`).
 *
 * Testes baseados em exemplo com `Date`s fixos (sem fast-check), cobrindo:
 * - cada gatilho disparando quando a condição é satisfeita e NÃO disparando
 *   quando não é (incluindo guardas de deadline nulo);
 * - `MANUAL` nunca dispara;
 * - regras inativas são ignoradas;
 * - idempotência (gatilho já em `escalatedTriggers` não é re-selecionado);
 * - múltiplas regras retornam exatamente o subconjunto que deve disparar.
 *
 * _Requisitos: 12.4, 12.5_
 */

import { describe, it, expect } from "vitest";

import { EscalationTrigger } from "@/lib/domain/enums";
import type { TicketSnapshot } from "@/lib/domain/types";
import {
  selectEscalations,
  jaEscalado,
  type EscalationRuleInput,
} from "@/lib/engines/escalation";

// Instantes fixos de referência.
const CREATED = new Date("2026-01-01T00:00:00.000Z");
const RESPONSE_DEADLINE = new Date("2026-01-01T01:00:00.000Z"); // +1h
const RESOLUTION_DEADLINE = new Date("2026-01-01T04:00:00.000Z"); // +4h

/** Snapshot base "saudável": sem resposta/resolução, com ambos os deadlines. */
function baseTicket(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    id: "t1",
    companyId: "c1",
    firstResponseAt: null,
    resolvedAt: null,
    slaResponseDeadline: RESPONSE_DEADLINE,
    slaResolutionDeadline: RESOLUTION_DEADLINE,
    updatedAt: CREATED,
    escalatedTriggers: [],
    ...overrides,
  };
}

function rule(
  trigger: EscalationTrigger,
  overrides: Partial<EscalationRuleInput> = {}
): EscalationRuleInput {
  return {
    id: `r-${trigger}`,
    trigger,
    afterMin: 15,
    active: true,
    toUserId: null,
    toTeamId: null,
    ...overrides,
  };
}

/** Retorna os ids das regras selecionadas. */
function ids(rules: EscalationRuleInput[]): string[] {
  return rules.map((r) => r.id);
}

describe("selectEscalations — RESPONSE_BREACH", () => {
  const r = rule(EscalationTrigger.RESPONSE_BREACH, { afterMin: 15 });
  // Limiar = deadline (01:00) + 15min = 01:15.
  const atThreshold = new Date("2026-01-01T01:15:00.000Z");
  const beforeThreshold = new Date("2026-01-01T01:14:59.000Z");

  it("dispara quando firstResponseAt é null e now >= deadline + afterMin", () => {
    expect(ids(selectEscalations(baseTicket(), [r], atThreshold))).toEqual([
      r.id,
    ]);
  });

  it("NÃO dispara quando now está antes do limiar", () => {
    expect(selectEscalations(baseTicket(), [r], beforeThreshold)).toEqual([]);
  });

  it("NÃO dispara quando firstResponseAt já está preenchido", () => {
    const ticket = baseTicket({ firstResponseAt: CREATED });
    expect(selectEscalations(ticket, [r], atThreshold)).toEqual([]);
  });

  it("NÃO dispara quando slaResponseDeadline é null", () => {
    const ticket = baseTicket({ slaResponseDeadline: null });
    expect(selectEscalations(ticket, [r], atThreshold)).toEqual([]);
  });
});

describe("selectEscalations — RESOLUTION_BREACH", () => {
  const r = rule(EscalationTrigger.RESOLUTION_BREACH, { afterMin: 30 });
  // Limiar = deadline (04:00) + 30min = 04:30.
  const atThreshold = new Date("2026-01-01T04:30:00.000Z");
  const beforeThreshold = new Date("2026-01-01T04:29:59.000Z");

  it("dispara quando resolvedAt é null e now >= deadline + afterMin", () => {
    expect(ids(selectEscalations(baseTicket(), [r], atThreshold))).toEqual([
      r.id,
    ]);
  });

  it("NÃO dispara quando now está antes do limiar", () => {
    expect(selectEscalations(baseTicket(), [r], beforeThreshold)).toEqual([]);
  });

  it("NÃO dispara quando resolvedAt já está preenchido", () => {
    const ticket = baseTicket({ resolvedAt: CREATED });
    expect(selectEscalations(ticket, [r], atThreshold)).toEqual([]);
  });

  it("NÃO dispara quando slaResolutionDeadline é null", () => {
    const ticket = baseTicket({ slaResolutionDeadline: null });
    expect(selectEscalations(ticket, [r], atThreshold)).toEqual([]);
  });
});

describe("selectEscalations — INACTIVITY", () => {
  const r = rule(EscalationTrigger.INACTIVITY, { afterMin: 60 });
  // updatedAt = 00:00; limiar = 01:00.
  const atThreshold = new Date("2026-01-01T01:00:00.000Z");
  const beforeThreshold = new Date("2026-01-01T00:59:59.000Z");

  it("dispara quando now >= updatedAt + afterMin", () => {
    expect(ids(selectEscalations(baseTicket(), [r], atThreshold))).toEqual([
      r.id,
    ]);
  });

  it("NÃO dispara antes do limiar", () => {
    expect(selectEscalations(baseTicket(), [r], beforeThreshold)).toEqual([]);
  });
});

describe("selectEscalations — MANUAL", () => {
  it("nunca dispara automaticamente, mesmo muito além de qualquer prazo", () => {
    const r = rule(EscalationTrigger.MANUAL, { afterMin: 0 });
    const farFuture = new Date("2027-01-01T00:00:00.000Z");
    expect(selectEscalations(baseTicket(), [r], farFuture)).toEqual([]);
  });
});

describe("selectEscalations — regras inativas", () => {
  it("ignora regras com active=false mesmo com gatilho satisfeito", () => {
    const r = rule(EscalationTrigger.INACTIVITY, {
      afterMin: 60,
      active: false,
    });
    const atThreshold = new Date("2026-01-01T01:00:00.000Z");
    expect(selectEscalations(baseTicket(), [r], atThreshold)).toEqual([]);
  });
});

describe("selectEscalations — idempotência", () => {
  it("não re-seleciona uma regra cujo gatilho já está em escalatedTriggers", () => {
    const r = rule(EscalationTrigger.INACTIVITY, { afterMin: 60 });
    const atThreshold = new Date("2026-01-01T01:00:00.000Z");
    const ticket = baseTicket({
      escalatedTriggers: [EscalationTrigger.INACTIVITY],
    });
    expect(selectEscalations(ticket, [r], atThreshold)).toEqual([]);
  });

  it("jaEscalado reflete a presença do gatilho no snapshot", () => {
    const ticket = baseTicket({
      escalatedTriggers: [EscalationTrigger.RESPONSE_BREACH],
    });
    expect(jaEscalado(ticket, EscalationTrigger.RESPONSE_BREACH)).toBe(true);
    expect(jaEscalado(ticket, EscalationTrigger.INACTIVITY)).toBe(false);
  });
});

describe("selectEscalations — múltiplas regras", () => {
  it("retorna exatamente o subconjunto de regras que deve disparar", () => {
    // now = 05:00 => bem além dos limiares de resposta (01:15) e resolução (04:30),
    // e de inatividade (01:00).
    const now = new Date("2026-01-01T05:00:00.000Z");

    const rResponse = rule(EscalationTrigger.RESPONSE_BREACH, {
      id: "resp",
      afterMin: 15,
    });
    const rResolution = rule(EscalationTrigger.RESOLUTION_BREACH, {
      id: "reso",
      afterMin: 30,
    });
    const rInactivity = rule(EscalationTrigger.INACTIVITY, {
      id: "inact",
      afterMin: 60,
    });
    const rManual = rule(EscalationTrigger.MANUAL, { id: "manual" });
    const rInactive = rule(EscalationTrigger.INACTIVITY, {
      id: "off",
      afterMin: 60,
      active: false,
    });
    // Já escalado por resolução => deve ser filtrado por idempotência.
    const rResolutionDup = rule(EscalationTrigger.RESOLUTION_BREACH, {
      id: "reso-dup",
      afterMin: 30,
    });

    const ticket = baseTicket({
      escalatedTriggers: [EscalationTrigger.RESOLUTION_BREACH],
    });

    const selected = selectEscalations(
      ticket,
      [rResponse, rResolution, rInactivity, rManual, rInactive, rResolutionDup],
      now
    );

    // Resposta e inatividade disparam; resolução (ambas) é filtrada pela
    // idempotência; MANUAL e a inativa nunca disparam.
    expect(ids(selected)).toEqual(["resp", "inact"]);
  });

  it("retorna [] quando não há regras", () => {
    const now = new Date("2026-01-01T05:00:00.000Z");
    expect(selectEscalations(baseTicket(), [], now)).toEqual([]);
  });
});
