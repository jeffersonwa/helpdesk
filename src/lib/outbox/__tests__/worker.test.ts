/**
 * Testes unitários do outbox worker (tarefa 23.3) — prisma mockado (in-memory).
 *
 * Cobrem:
 *  - Idempotência: evento já `SENT` não é reprocessado; o claim
 *    (`PENDING → PROCESSING` condicional) impede execução dupla mesmo com dois
 *    workers concorrentes sobre o mesmo lote.
 *  - Backoff exponencial: `attempts` incrementa e `nextRunAt` cresce 60s→120s→…,
 *    limitado a 3600s.
 *  - `FAILED` após 5 tentativas + alerta emitido.
 *
 * _Requisitos: 17.5, 17.6_
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutboxState } from "@/lib/domain/enums";
import {
  backoffMs,
  createOutboxRegistry,
  MAX_ATTEMPTS,
  processOutboxOnce,
  registerOutboxHandler,
  type WorkerPrisma,
} from "@/lib/outbox/worker";

/** Registro em memória de um OutboxEvent. */
interface Row {
  id: string;
  companyId: string;
  type: string;
  payload: unknown;
  state: string;
  attempts: number;
  nextRunAt: Date;
  createdAt: Date;
}

/**
 * Fake prisma que modela a tabela `OutboxEvent` com a semântica necessária:
 * `findMany` (filtro state+nextRunAt, orderBy, take, select), `updateMany`
 * (claim condicional, retorna `{count}`) e `update` (por id).
 */
function makeFakePrisma(seed: Row[]) {
  const rows: Row[] = seed.map((r) => ({ ...r }));

  const prisma = {
    outboxEvent: {
      async findMany(args: {
        where: { state: string; nextRunAt: { lte: Date } };
        orderBy: { nextRunAt: "asc" };
        take?: number;
        select: Record<string, boolean>;
      }) {
        let out = rows
          .filter(
            (r) =>
              r.state === args.where.state &&
              r.nextRunAt.getTime() <= args.where.nextRunAt.lte.getTime(),
          )
          .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime());
        if (typeof args.take === "number") out = out.slice(0, args.take);
        // Devolve cópias com apenas os campos selecionados (mais próximo do real).
        return out.map((r) => ({
          id: r.id,
          companyId: r.companyId,
          type: r.type,
          payload: r.payload,
          attempts: r.attempts,
        }));
      },
      async updateMany(args: {
        where: { id: string; state: string };
        data: Partial<Row>;
      }) {
        const r = rows.find(
          (x) => x.id === args.where.id && x.state === args.where.state,
        );
        if (!r) return { count: 0 };
        Object.assign(r, args.data);
        return { count: 1 };
      },
      async update(args: { where: { id: string }; data: Partial<Row> }) {
        const r = rows.find((x) => x.id === args.where.id);
        if (!r) throw new Error(`row not found: ${args.where.id}`);
        Object.assign(r, args.data);
        return { ...r };
      },
    },
  } satisfies WorkerPrisma as unknown as WorkerPrisma;

  return { prisma, rows };
}

function seedEvent(over: Partial<Row> = {}): Row {
  return {
    id: over.id ?? "evt-1",
    companyId: over.companyId ?? "co-1",
    type: over.type ?? "webhook.dispatch",
    payload: over.payload ?? { event: "ticket.created" },
    state: over.state ?? OutboxState.PENDING,
    attempts: over.attempts ?? 0,
    nextRunAt: over.nextRunAt ?? new Date("2025-01-01T00:00:00.000Z"),
    createdAt: over.createdAt ?? new Date("2025-01-01T00:00:00.000Z"),
  };
}

const NOW = new Date("2025-01-01T01:00:00.000Z");

describe("backoffMs", () => {
  it("segue 60s→120s→240s→480s e satura em 3600s", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(4)).toBe(480_000);
    // 60s * 2^5 = 1_920_000 (< cap)
    expect(backoffMs(6)).toBe(1_920_000);
    // 60s * 2^6 = 3_840_000 > cap → 3_600_000
    expect(backoffMs(7)).toBe(3_600_000);
    // valores grandes saturam
    expect(backoffMs(100)).toBe(3_600_000);
  });
});

describe("processOutboxOnce — sucesso e idempotência", () => {
  let registry: ReturnType<typeof createOutboxRegistry>;

  beforeEach(() => {
    registry = createOutboxRegistry();
  });

  it("marca SENT ao sucesso do handler e chama o handler uma única vez", async () => {
    const { prisma, rows } = makeFakePrisma([seedEvent()]);
    const handler = vi.fn().mockResolvedValue(undefined);
    registerOutboxHandler("webhook.dispatch", handler, registry);

    const res = await processOutboxOnce({
      prisma,
      registry,
      now: () => NOW,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ claimed: 1, sent: 1, failed: 0, rescheduled: 0 });
    expect(rows[0].state).toBe(OutboxState.SENT);
  });

  it("não reprocessa um evento já SENT (não está mais PENDING)", async () => {
    const { prisma, rows } = makeFakePrisma([
      seedEvent({ state: OutboxState.SENT }),
    ]);
    const handler = vi.fn().mockResolvedValue(undefined);
    registerOutboxHandler("webhook.dispatch", handler, registry);

    const res = await processOutboxOnce({ prisma, registry, now: () => NOW });

    expect(handler).not.toHaveBeenCalled();
    expect(res.claimed).toBe(0);
    expect(rows[0].state).toBe(OutboxState.SENT);
  });

  it("o claim PROCESSING impede processamento duplo em execuções concorrentes", async () => {
    const { prisma, rows } = makeFakePrisma([seedEvent()]);
    const handler = vi.fn().mockResolvedValue(undefined);
    registerOutboxHandler("webhook.dispatch", handler, registry);

    // Dois workers processam o MESMO lote em paralelo; apenas um vence o claim.
    const [a, b] = await Promise.all([
      processOutboxOnce({ prisma, registry, now: () => NOW }),
      processOutboxOnce({ prisma, registry, now: () => NOW }),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.sent + b.sent).toBe(1);
    expect(rows[0].state).toBe(OutboxState.SENT);
  });
});

describe("processOutboxOnce — falha, backoff e FAILED", () => {
  let registry: ReturnType<typeof createOutboxRegistry>;

  beforeEach(() => {
    registry = createOutboxRegistry();
  });

  it("na falha transitória incrementa attempts e reagenda com backoff", async () => {
    const { prisma, rows } = makeFakePrisma([seedEvent({ attempts: 0 })]);
    registerOutboxHandler(
      "webhook.dispatch",
      vi.fn().mockRejectedValue(new Error("timeout")),
      registry,
    );

    const res = await processOutboxOnce({ prisma, registry, now: () => NOW });

    expect(res).toMatchObject({ claimed: 1, rescheduled: 1, failed: 0 });
    expect(rows[0].state).toBe(OutboxState.PENDING);
    expect(rows[0].attempts).toBe(1);
    // nextRunAt = NOW + backoff(1) = NOW + 60s
    expect(rows[0].nextRunAt.getTime()).toBe(NOW.getTime() + 60_000);
  });

  it("nextRunAt cresce exponencialmente a cada tentativa sucessiva", async () => {
    const { prisma, rows } = makeFakePrisma([seedEvent({ attempts: 0 })]);
    registerOutboxHandler(
      "webhook.dispatch",
      vi.fn().mockRejectedValue(new Error("5xx")),
      registry,
    );

    const expected = [60_000, 120_000, 240_000, 480_000];
    for (let i = 0; i < expected.length; i++) {
      // Torna o evento "devido" a cada rodada (nextRunAt <= NOW).
      rows[0].nextRunAt = new Date(NOW.getTime() - 1);
      rows[0].state = OutboxState.PENDING;
      await processOutboxOnce({ prisma, registry, now: () => NOW });
      expect(rows[0].attempts).toBe(i + 1);
      expect(rows[0].nextRunAt.getTime()).toBe(NOW.getTime() + expected[i]);
    }
  });

  it("marca FAILED e emite alerta após 5 tentativas", async () => {
    // Já com 4 tentativas: a 5ª falha ultrapassa o limite → FAILED.
    const { prisma, rows } = makeFakePrisma([
      seedEvent({ attempts: MAX_ATTEMPTS - 1 }),
    ]);
    registerOutboxHandler(
      "webhook.dispatch",
      vi.fn().mockRejectedValue(new Error("still failing")),
      registry,
    );
    const alert = vi.fn();

    const res = await processOutboxOnce({
      prisma,
      registry,
      now: () => NOW,
      alert,
    });

    expect(res).toMatchObject({ claimed: 1, failed: 1, rescheduled: 0 });
    expect(rows[0].state).toBe(OutboxState.FAILED);
    expect(rows[0].attempts).toBe(MAX_ATTEMPTS);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt-1", type: "webhook.dispatch" }),
      expect.any(Error),
    );
  });

  it("evento sem handler registrado é devolvido a PENDING sem contar tentativa", async () => {
    const { prisma, rows } = makeFakePrisma([
      seedEvent({ type: "unknown.type", attempts: 0 }),
    ]);

    const res = await processOutboxOnce({ prisma, registry, now: () => NOW });

    expect(res.skippedNoHandler).toBe(1);
    expect(rows[0].state).toBe(OutboxState.PENDING);
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].nextRunAt.getTime()).toBe(NOW.getTime() + 60_000);
  });
});
