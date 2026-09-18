/**
 * ConversationService — upsert de conversa e persistência de mensagem inbound.
 *
 * Tarefa 17.1. Fonte autoritativa:
 * `.kiro/specs/helpdesk-omnichannel/design.md` (seções "Camada de Ingestão
 * Omnichannel" e "Design de Baixo Nível") e requirements 10.
 *
 * Responsabilidades (Req. 10.1, 10.2, 10.3, 10.6, 10.7):
 *  - `upsertConversation`: garante EXATAMENTE uma `Conversation` por
 *    (companyId, channelAccountId, contactExternalId). Como o schema não impõe
 *    `@@unique` nessa tripla (apenas índice), o upsert é um find-then-create
 *    dentro de uma transação — o `IngestionRouter` já serializa a ingestão de
 *    uma mesma mensagem via idempotência de `externalId`, então a corrida de
 *    criação de conversa para o MESMO contato é evitada na prática.
 *  - `persistInboundMessage`: cria uma `Message` INBOUND. A idempotência se
 *    apoia em `@@unique([companyId, externalId])`; uma duplicata (P2002) é
 *    tratada como NO-OP (nunca como erro), devolvendo a mensagem já existente.
 *  - Escritas de estado da conversa são restritas a OPEN/PENDING/RESOLVED/
 *    EXPIRED (Req. 10.6) por um guard de enum fail-closed.
 *
 * Princípio inviolável: `companyId` é SEMPRE derivado do servidor pelo chamador
 * (o `IngestionRouter` o obtém da `ChannelAccount`); estes métodos apenas o
 * repassam. Nenhuma falha de persistência não-duplicata é engolida: ela é
 * propagada para que a transação do chamador faça rollback e o ticket não seja
 * criado/alterado (Req. 10.3).
 *
 * _Requisitos: 10.1, 10.2, 10.3, 10.6, 10.7_
 */

import { Prisma } from "@prisma/client";
import type { Prisma as PrismaNS } from "@prisma/client";
import { ConversationState, MessageDirection } from "@/lib/domain/enums";
import type { InboundMessage } from "@/lib/domain/types";

/** Cliente de transação do Prisma — todos os métodos rodam DENTRO de `tx`. */
export type ConversationTx = PrismaNS.TransactionClient;

/** Conjunto fechado de estados legais da conversa (Req. 10.6). */
const VALID_CONVERSATION_STATES: ReadonlySet<string> = new Set<string>(
  Object.values(ConversationState),
);

/**
 * Type guard fail-closed: reconhece um estado de conversa legal (Req. 10.6).
 * Qualquer valor fora do enum é rejeitado.
 */
export function isValidConversationState(
  value: string,
): value is ConversationState {
  return VALID_CONVERSATION_STATES.has(value);
}

/**
 * Erro lançado quando se tenta escrever um estado de conversa fora do conjunto
 * legal OPEN/PENDING/RESOLVED/EXPIRED (Req. 10.6).
 */
export class InvalidConversationStateError extends Error {
  readonly code = "INVALID_CONVERSATION_STATE" as const;

  constructor(state: string) {
    super(`Estado de conversa inválido: ${state}`);
    this.name = "InvalidConversationStateError";
    Object.setPrototypeOf(this, InvalidConversationStateError.prototype);
  }
}

/** Detecta violação de unicidade do Prisma (P2002) — duplicata de `externalId`. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/** Conversa retornada pelos métodos do serviço (campos essenciais). */
export interface ConversationRow {
  id: string;
  companyId: string;
  channelAccountId: string;
  contactExternalId: string;
  contactName: string | null;
  state: string;
  windowExpiresAt: Date | null;
}

/** Entrada de `upsertConversation`. */
export interface UpsertConversationInput {
  companyId: string;
  channelAccountId: string;
  contactExternalId: string;
  contactName?: string;
  /** Definido pelo chamador quando o canal tem janela de sessão (Req. 10.7). */
  windowExpiresAt?: Date;
  /** Estado inicial/desejado — precisa ser legal (Req. 10.6). Default OPEN. */
  state?: ConversationState;
}

/**
 * Encontra ou cria EXATAMENTE uma `Conversation` por
 * (companyId, channelAccountId, contactExternalId) — Req. 10.1.
 *
 * Se encontrada, atualiza opcionalmente `contactName`/`windowExpiresAt` (e
 * `state` quando informado) e a devolve. Se não, cria uma nova. Deve rodar
 * dentro de `prisma.$transaction`.
 *
 * @throws {InvalidConversationStateError} se `state` for informado e ilegal.
 */
export async function upsertConversation(
  tx: ConversationTx,
  input: UpsertConversationInput,
): Promise<ConversationRow> {
  // Guard de estado (fail-closed) antes de qualquer escrita (Req. 10.6).
  if (input.state !== undefined && !isValidConversationState(input.state)) {
    throw new InvalidConversationStateError(input.state);
  }

  const existing = await tx.conversation.findFirst({
    where: {
      companyId: input.companyId,
      channelAccountId: input.channelAccountId,
      contactExternalId: input.contactExternalId,
    },
    select: {
      id: true,
      companyId: true,
      channelAccountId: true,
      contactExternalId: true,
      contactName: true,
      state: true,
      windowExpiresAt: true,
    },
  });

  if (existing) {
    // Só emite update se houver algo a atualizar (evita round-trip supérfluo).
    const data: PrismaNS.ConversationUpdateInput = {};
    if (input.contactName !== undefined) data.contactName = input.contactName;
    if (input.windowExpiresAt !== undefined) {
      data.windowExpiresAt = input.windowExpiresAt;
    }
    if (input.state !== undefined) data.state = input.state;

    if (Object.keys(data).length === 0) {
      return existing;
    }

    const updated = await tx.conversation.update({
      where: { id: existing.id },
      data,
      select: {
        id: true,
        companyId: true,
        channelAccountId: true,
        contactExternalId: true,
        contactName: true,
        state: true,
        windowExpiresAt: true,
      },
    });
    return updated;
  }

  const created = await tx.conversation.create({
    data: {
      companyId: input.companyId,
      channelAccountId: input.channelAccountId,
      contactExternalId: input.contactExternalId,
      contactName: input.contactName ?? null,
      state: input.state ?? ConversationState.OPEN,
      windowExpiresAt: input.windowExpiresAt ?? null,
    },
    select: {
      id: true,
      companyId: true,
      channelAccountId: true,
      contactExternalId: true,
      contactName: true,
      state: true,
      windowExpiresAt: true,
    },
  });
  return created;
}

/** Mensagem persistida (campos essenciais). */
export interface MessageRow {
  id: string;
  companyId: string;
  conversationId: string;
  externalId: string | null;
}

/** Resultado de `persistInboundMessage`. */
export interface PersistInboundResult {
  message: MessageRow;
  /**
   * `true` quando a mensagem já existia (duplicata de `externalId` detectada via
   * P2002) e o insert foi tratado como no-op idempotente (Req. 10.2).
   */
  duplicate: boolean;
}

/**
 * Persiste uma `Message` INBOUND da conversa (Req. 10.2).
 *
 * Idempotência: se `@@unique([companyId, externalId])` for violada (P2002), a
 * duplicata é tratada como NO-OP — a mensagem já existente é buscada e devolvida
 * com `duplicate: true`, e NENHUM erro é lançado. Qualquer outra falha de
 * persistência é PROPAGADA para o chamador (Req. 10.3), de modo que a transação
 * seja revertida e o ticket não seja criado/alterado.
 *
 * Deve rodar dentro de `prisma.$transaction`.
 */
export async function persistInboundMessage(
  tx: ConversationTx,
  conversationId: string,
  companyId: string,
  inbound: InboundMessage,
): Promise<PersistInboundResult> {
  try {
    const created = await tx.message.create({
      data: {
        companyId,
        conversationId,
        direction: MessageDirection.INBOUND,
        type: inbound.type,
        body: inbound.body ?? null,
        mediaUrl: inbound.mediaRef ?? null,
        externalId: inbound.externalId,
        createdAt: inbound.timestamp,
      },
      select: {
        id: true,
        companyId: true,
        conversationId: true,
        externalId: true,
      },
    });
    return { message: created, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Duplicata idempotente (Req. 10.2): busca a mensagem já persistida.
      const existing = await tx.message.findUnique({
        where: {
          companyId_externalId: {
            companyId,
            externalId: inbound.externalId,
          },
        },
        select: {
          id: true,
          companyId: true,
          conversationId: true,
          externalId: true,
        },
      });
      if (existing) {
        return { message: existing, duplicate: true };
      }
      // Caso extremo: P2002 mas a linha não foi encontrada (corrida rara).
      // Trata como duplicata sem mensagem materializada, ainda sem erro.
      return {
        message: {
          id: "",
          companyId,
          conversationId,
          externalId: inbound.externalId,
        },
        duplicate: true,
      };
    }
    // Falha NÃO-duplicata: propaga para o rollback do chamador (Req. 10.3).
    throw err;
  }
}
