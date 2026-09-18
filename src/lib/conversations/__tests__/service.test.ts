/**
 * Testes unitários do ConversationService (tarefa 17.2).
 *
 * O `tx` (Prisma.TransactionClient) é mockado — sem I/O real. Cobrem:
 *  - upsert único por (contato, canal): reaproveita conversa existente;
 *  - duplicata de `externalId` → no-op (P2002 capturado, sem erro);
 *  - estado de conversa inválido rejeitado (fail-closed);
 *  - falha de persistência NÃO-duplicata propaga (rollback do chamador).
 *
 * _Requisitos: 10.1, 10.2, 10.3, 10.6_
 */

import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ConversationState, MessageType } from "@/lib/domain/enums";
import type { InboundMessage } from "@/lib/domain/types";
import {
  InvalidConversationStateError,
  isValidConversationState,
  persistInboundMessage,
  upsertConversation,
  type ConversationTx,
} from "@/lib/conversations/service";

/** Constrói um P2002 (unique violation) do Prisma para simular duplicata. */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    companyId: "co-1",
    channelAccountId: "acc-1",
    contactExternalId: "+5511999999999",
    contactName: "Fulano",
    type: MessageType.TEXT,
    body: "olá",
    externalId: "ext-abc",
    timestamp: new Date("2026-01-01T12:00:00.000Z"),
    ...overrides,
  };
}

describe("ConversationService.upsertConversation", () => {
  it("reaproveita EXATAMENTE uma conversa por (contato, canal) sem criar outra", async () => {
    const found = {
      id: "conv-1",
      companyId: "co-1",
      channelAccountId: "acc-1",
      contactExternalId: "+5511999999999",
      contactName: "Fulano",
      state: ConversationState.OPEN,
      windowExpiresAt: null,
    };
    const create = vi.fn();
    const update = vi.fn();
    const tx = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue(found),
        create,
        update,
      },
    } as unknown as ConversationTx;

    const result = await upsertConversation(tx, {
      companyId: "co-1",
      channelAccountId: "acc-1",
      contactExternalId: "+5511999999999",
    });

    expect(result.id).toBe("conv-1");
    // Sem nada a atualizar → nenhum create e nenhum update (upsert único).
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("cria a conversa quando nenhuma existe para o par (contato, canal)", async () => {
    const created = {
      id: "conv-new",
      companyId: "co-1",
      channelAccountId: "acc-1",
      contactExternalId: "+5511888888888",
      contactName: "Ciclano",
      state: ConversationState.OPEN,
      windowExpiresAt: new Date("2026-01-02T12:00:00.000Z"),
    };
    const create = vi.fn().mockResolvedValue(created);
    const tx = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
        update: vi.fn(),
      },
    } as unknown as ConversationTx;

    const result = await upsertConversation(tx, {
      companyId: "co-1",
      channelAccountId: "acc-1",
      contactExternalId: "+5511888888888",
      contactName: "Ciclano",
      windowExpiresAt: new Date("2026-01-02T12:00:00.000Z"),
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.id).toBe("conv-new");
  });

  it("atualiza contactName/windowExpiresAt quando a conversa já existe", async () => {
    const found = {
      id: "conv-1",
      companyId: "co-1",
      channelAccountId: "acc-1",
      contactExternalId: "+5511999999999",
      contactName: null,
      state: ConversationState.OPEN,
      windowExpiresAt: null,
    };
    const update = vi.fn().mockResolvedValue({
      ...found,
      contactName: "Novo Nome",
      windowExpiresAt: new Date("2026-01-03T00:00:00.000Z"),
    });
    const tx = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue(found),
        create: vi.fn(),
        update,
      },
    } as unknown as ConversationTx;

    const result = await upsertConversation(tx, {
      companyId: "co-1",
      channelAccountId: "acc-1",
      contactExternalId: "+5511999999999",
      contactName: "Novo Nome",
      windowExpiresAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(result.contactName).toBe("Novo Nome");
  });

  it("rejeita estado de conversa inválido (fail-closed) sem tocar o banco", async () => {
    const findFirst = vi.fn();
    const tx = {
      conversation: { findFirst, create: vi.fn(), update: vi.fn() },
    } as unknown as ConversationTx;

    await expect(
      upsertConversation(tx, {
        companyId: "co-1",
        channelAccountId: "acc-1",
        contactExternalId: "+5511999999999",
        // valor ilegal fora de OPEN/PENDING/RESOLVED/EXPIRED
        state: "CLOSED" as unknown as ConversationState,
      }),
    ).rejects.toBeInstanceOf(InvalidConversationStateError);

    expect(findFirst).not.toHaveBeenCalled();
  });

  it("guard de estado aceita apenas OPEN/PENDING/RESOLVED/EXPIRED", () => {
    expect(isValidConversationState("OPEN")).toBe(true);
    expect(isValidConversationState("PENDING")).toBe(true);
    expect(isValidConversationState("RESOLVED")).toBe(true);
    expect(isValidConversationState("EXPIRED")).toBe(true);
    expect(isValidConversationState("CLOSED")).toBe(false);
    expect(isValidConversationState("")).toBe(false);
  });
});

describe("ConversationService.persistInboundMessage", () => {
  it("persiste uma Message INBOUND (duplicate=false) mapeando mediaRef → mediaUrl", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "msg-1",
      companyId: "co-1",
      conversationId: "conv-1",
      externalId: "ext-abc",
    });
    const tx = {
      message: { create, findUnique: vi.fn() },
    } as unknown as ConversationTx;

    const inbound = makeInbound({ mediaRef: "media-xyz", body: undefined });
    const result = await persistInboundMessage(tx, "conv-1", "co-1", inbound);

    expect(result.duplicate).toBe(false);
    expect(result.message.id).toBe("msg-1");
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0].data;
    expect(arg.direction).toBe("INBOUND");
    expect(arg.mediaUrl).toBe("media-xyz");
    expect(arg.externalId).toBe("ext-abc");
    expect(arg.companyId).toBe("co-1");
  });

  it("trata duplicata de externalId como no-op idempotente (P2002 capturado)", async () => {
    const existing = {
      id: "msg-existing",
      companyId: "co-1",
      conversationId: "conv-1",
      externalId: "ext-abc",
    };
    const create = vi.fn().mockRejectedValue(p2002());
    const findUnique = vi.fn().mockResolvedValue(existing);
    const tx = {
      message: { create, findUnique },
    } as unknown as ConversationTx;

    const result = await persistInboundMessage(
      tx,
      "conv-1",
      "co-1",
      makeInbound(),
    );

    expect(result.duplicate).toBe(true);
    expect(result.message.id).toBe("msg-existing");
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("propaga falha de persistência NÃO-duplicata (rollback do chamador)", async () => {
    const boom = new Error("db down");
    const create = vi.fn().mockRejectedValue(boom);
    const findUnique = vi.fn();
    const tx = {
      message: { create, findUnique },
    } as unknown as ConversationTx;

    await expect(
      persistInboundMessage(tx, "conv-1", "co-1", makeInbound()),
    ).rejects.toBe(boom);
    // Não tenta buscar duplicata em erro não-P2002.
    expect(findUnique).not.toHaveBeenCalled();
  });
});
