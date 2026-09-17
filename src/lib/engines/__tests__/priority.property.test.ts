/**
 * Testes do PriorityEngine (`derivePriority`).
 *
 * Cobre:
 *  - Property 1: Monotonicidade da prioridade (Requisito 12.7)
 *  - Property 2: Determinismo da prioridade (Requisito 12.6)
 *  - Cobertura exaustiva das 9 células da matriz impacto × urgência
 *    (trava a matriz do design — Requisito 4.7).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { derivePriority } from "@/lib/engines/priority";
import { Impact, Priority, Urgency } from "@/lib/domain/enums";

/**
 * Ordem total sobre `Priority`: LOW < MEDIUM < HIGH < CRITICAL.
 * `rank` mapeia cada prioridade para um inteiro ordenável.
 */
const PRIORITY_RANK: Record<Priority, number> = {
  [Priority.LOW]: 0,
  [Priority.MEDIUM]: 1,
  [Priority.HIGH]: 2,
  [Priority.CRITICAL]: 3,
};

/** Ordem total sobre `Impact`/`Urgency`: LOW < MEDIUM < HIGH. */
const LEVEL_RANK = {
  [Impact.LOW]: 0,
  [Impact.MEDIUM]: 1,
  [Impact.HIGH]: 2,
} as const;

const rank = (p: Priority): number => PRIORITY_RANK[p];

// Arbitrários sobre os enums de domínio.
const impactArb: fc.Arbitrary<Impact> = fc.constantFrom(
  Impact.LOW,
  Impact.MEDIUM,
  Impact.HIGH,
);
const urgencyArb: fc.Arbitrary<Urgency> = fc.constantFrom(
  Urgency.LOW,
  Urgency.MEDIUM,
  Urgency.HIGH,
);

describe("PriorityEngine — derivePriority", () => {
  describe("Property 1: Monotonicidade da prioridade (Requisito 12.7)", () => {
    it("aumentar o impacto (urgência fixa) nunca reduz a prioridade", () => {
      fc.assert(
        fc.property(impactArb, impactArb, urgencyArb, (i1, i2, u) => {
          // Considera apenas pares ordenados i1 <= i2.
          fc.pre(LEVEL_RANK[i1] <= LEVEL_RANK[i2]);
          return rank(derivePriority(i2, u)) >= rank(derivePriority(i1, u));
        }),
      );
    });

    it("aumentar a urgência (impacto fixo) nunca reduz a prioridade", () => {
      fc.assert(
        fc.property(urgencyArb, urgencyArb, impactArb, (u1, u2, i) => {
          fc.pre(LEVEL_RANK[u1] <= LEVEL_RANK[u2]);
          return rank(derivePriority(i, u2)) >= rank(derivePriority(i, u1));
        }),
      );
    });

    it("monotonicidade combinada: i1<=i2 E u1<=u2 nunca reduz a prioridade", () => {
      fc.assert(
        fc.property(
          impactArb,
          impactArb,
          urgencyArb,
          urgencyArb,
          (i1, i2, u1, u2) => {
            fc.pre(
              LEVEL_RANK[i1] <= LEVEL_RANK[i2] &&
                LEVEL_RANK[u1] <= LEVEL_RANK[u2],
            );
            return (
              rank(derivePriority(i2, u2)) >= rank(derivePriority(i1, u1))
            );
          },
        ),
      );
    });
  });

  describe("Property 2: Determinismo da prioridade (Requisito 12.6)", () => {
    it("o mesmo par (impact, urgency) retorna sempre a mesma Priority", () => {
      fc.assert(
        fc.property(impactArb, urgencyArb, (i, u) => {
          const first = derivePriority(i, u);
          // Chamadas repetidas devem coincidir (função pura, sem estado).
          for (let n = 0; n < 5; n++) {
            if (derivePriority(i, u) !== first) {
              return false;
            }
          }
          return true;
        }),
      );
    });
  });

  describe("Cobertura exaustiva da matriz impacto × urgência (Requisito 4.7)", () => {
    const cases: Array<[Impact, Urgency, Priority]> = [
      [Impact.HIGH, Urgency.HIGH, Priority.CRITICAL],
      [Impact.HIGH, Urgency.MEDIUM, Priority.HIGH],
      [Impact.HIGH, Urgency.LOW, Priority.MEDIUM],
      [Impact.MEDIUM, Urgency.HIGH, Priority.HIGH],
      [Impact.MEDIUM, Urgency.MEDIUM, Priority.MEDIUM],
      [Impact.MEDIUM, Urgency.LOW, Priority.LOW],
      [Impact.LOW, Urgency.HIGH, Priority.MEDIUM],
      [Impact.LOW, Urgency.MEDIUM, Priority.LOW],
      [Impact.LOW, Urgency.LOW, Priority.LOW],
    ];

    it.each(cases)(
      "derivePriority(%s, %s) === %s",
      (impact, urgency, expected) => {
        expect(derivePriority(impact, urgency)).toBe(expected);
      },
    );

    it("cobre exatamente as 9 células (3 impactos × 3 urgências)", () => {
      expect(cases).toHaveLength(9);
    });
  });
});
