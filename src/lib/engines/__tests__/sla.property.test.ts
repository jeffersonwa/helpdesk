/**
 * Testes do SlaEngine (`calcSla`, `slaStatus`) — núcleo puro.
 *
 * Cobre:
 *  - Property 3: Ordenação de prazos de SLA (Requisito 12.2)
 *  - Property 4: Coerência do status de SLA (Requisito 12.3)
 *  - Exemplos de fronteira do status (warning < 2h, ok, breached, null).
 *
 * Importa diretamente de `@/lib/engines/sla` (módulo livre de Prisma), de modo
 * que a suíte carregue sem client gerado nem `DATABASE_URL`.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { calcSla, slaStatus } from "@/lib/engines/sla";

const MS_PER_HOUR = 1000 * 60 * 60;

// Datas geradas a partir de inteiros de milissegundos limitados, para manter
// os cálculos dentro de faixas seguras (sem overflow de Date).
const dateArb: fc.Arbitrary<Date> = fc
  .integer({ min: 0, max: 4_102_444_800_000 }) // 1970-01-01 .. ~2100-01-01
  .map((ms) => new Date(ms));

// Horas não-negativas limitadas (0 .. ~1 ano) para caber na faixa de Date.
const hoursArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 8760 });

describe("SlaEngine — calcSla", () => {
  describe("Property 3: Ordenação de prazos de SLA (Requisito 12.2)", () => {
    it("responseHours <= resolutionHours ⇒ responseDeadline <= resolutionDeadline", () => {
      fc.assert(
        fc.property(dateArb, hoursArb, hoursArb, (createdAt, responseHours, delta) => {
          const resolutionHours = responseHours + delta; // garante response <= resolution
          const { responseDeadline, resolutionDeadline } = calcSla(
            { responseHours, resolutionHours },
            createdAt,
          );
          return responseDeadline.getTime() <= resolutionDeadline.getTime();
        }),
      );
    });

    it("cada prazo é > createdAt quando as horas > 0, e === createdAt quando 0", () => {
      fc.assert(
        fc.property(dateArb, hoursArb, hoursArb, (createdAt, responseHours, delta) => {
          const resolutionHours = responseHours + delta;
          const { responseDeadline, resolutionDeadline } = calcSla(
            { responseHours, resolutionHours },
            createdAt,
          );
          const created = createdAt.getTime();

          // Borda 0: sem horas, o prazo coincide com createdAt.
          const responseOk =
            responseHours > 0
              ? responseDeadline.getTime() > created
              : responseDeadline.getTime() === created;
          const resolutionOk =
            resolutionHours > 0
              ? resolutionDeadline.getTime() > created
              : resolutionDeadline.getTime() === created;

          return responseOk && resolutionOk;
        }),
      );
    });

    it("não muta createdAt", () => {
      fc.assert(
        fc.property(dateArb, hoursArb, hoursArb, (createdAt, responseHours, delta) => {
          const before = createdAt.getTime();
          calcSla({ responseHours, resolutionHours: responseHours + delta }, createdAt);
          return createdAt.getTime() === before;
        }),
      );
    });

    it("exemplo concreto: 4h e 8h a partir de um instante fixo", () => {
      const createdAt = new Date("2026-01-01T00:00:00.000Z");
      const { responseDeadline, resolutionDeadline } = calcSla(
        { responseHours: 4, resolutionHours: 8 },
        createdAt,
      );
      expect(responseDeadline.toISOString()).toBe("2026-01-01T04:00:00.000Z");
      expect(resolutionDeadline.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    });
  });
});

describe("SlaEngine — slaStatus", () => {
  describe("Property 4: Coerência do status de SLA (Requisito 12.3)", () => {
    it('retorna "breached" sse deadline < now', () => {
      fc.assert(
        fc.property(dateArb, dateArb, (deadline, now) => {
          const result = slaStatus(deadline, now);
          return (result === "breached") === (deadline.getTime() < now.getTime());
        }),
      );
    });
  });

  describe("Exemplos de fronteira", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");

    it('deadline nulo ⇒ "ok"', () => {
      expect(slaStatus(null, now)).toBe("ok");
    });

    it('deadline no passado ⇒ "breached"', () => {
      const past = new Date(now.getTime() - 1);
      expect(slaStatus(past, now)).toBe("breached");
    });

    it('restando < 2h ⇒ "warning" (ex.: 1h59min)', () => {
      const soon = new Date(now.getTime() + (2 * MS_PER_HOUR - 60_000));
      expect(slaStatus(soon, now)).toBe("warning");
    });

    it('exatamente 2h restantes ⇒ "ok" (fronteira não inclusiva)', () => {
      const twoHours = new Date(now.getTime() + 2 * MS_PER_HOUR);
      expect(slaStatus(twoHours, now)).toBe("ok");
    });

    it('restando > 2h ⇒ "ok"', () => {
      const later = new Date(now.getTime() + 5 * MS_PER_HOUR);
      expect(slaStatus(later, now)).toBe("ok");
    });

    it("usa o relógio do sistema quando now é omitido (prazo bem no futuro ⇒ ok)", () => {
      const farFuture = new Date(Date.now() + 100 * MS_PER_HOUR);
      expect(slaStatus(farFuture)).toBe("ok");
    });
  });
});
