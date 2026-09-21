/**
 * Testes unitários do outbox dispatcher (tarefa 23.3) — prisma/tx mockado.
 *
 * Verifica que `enqueue` cria um `OutboxEvent` PENDING, attempts=0 e
 * nextRunAt=now, usando o client fornecido (tx) — base do outbox transacional.
 *
 * _Requisitos: 17.1_
 */

import { describe, expect, it, vi } from "vitest";
import { OutboxState } from "@/lib/domain/enums";
import { enqueue, type OutboxCapableClient } from "@/lib/outbox/dispatcher";

const NOW = new Date("2025-06-01T12:00:00.000Z");

function makeClient() {
  const create = vi.fn().mockResolvedValue({ id: "evt-123" });
  const client = { outboxEvent: { create } } as unknown as OutboxCapableClient;
  return { client, create };
}

describe("enqueue", () => {
  it("cria OutboxEvent PENDING/attempts=0/nextRunAt=now e retorna o id", async () => {
    const { client, create } = makeClient();

    const id = await enqueue(
      client,
      {
        companyId: "co-1",
        type: "webhook.dispatch",
        payload: { event: "ticket.created", ticketId: "t-1" },
      },
      () => NOW,
    );

    expect(id).toBe("evt-123");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        companyId: "co-1",
        type: "webhook.dispatch",
        payload: { event: "ticket.created", ticketId: "t-1" },
        state: OutboxState.PENDING,
        attempts: 0,
        nextRunAt: NOW,
      },
    });
  });
});
