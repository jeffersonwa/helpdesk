/**
 * IngestionRouter — normalização → roteamento → conversa/ticket (tarefa 16.1).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seções "Camada de Ingestão Omnichannel" e "Design de Baixo Nível" —
 * pseudocódigo `route(msg)`) e requirements 5 e 10.
 *
 * Fluxo de `route(msg)` conforme o pseudocódigo do design:
 *  1. Resolver a `ChannelAccount` por `msg.channelAccountId` (server-side) e
 *     ASSERTAR `account.companyId === msg.companyId` (isolamento de tenant).
 *       - Conta não resolvida OU canal desconhecido → DESCARTE (erro tipado),
 *         SEM criar `Message`/`Ticket` (Req. 5.5, 10.8).
 *       - Divergência de tenant → REJEIÇÃO (Req. 1.6, 5.5).
 *  2. Idempotência: se já existe `Message (companyId, externalId)`, devolve o
 *     vínculo já existente (nenhuma nova `Message`/`Ticket`) — Req. 5.6, 6.12,
 *     10.2 (Correctness Property 5).
 *  3. Em `prisma.$transaction`:
 *       a. `upsertConversation` (janela de 24h quando o canal é WHATSAPP —
 *          `windowExpiresAt = msg.timestamp + 24h`, Req. 10.7);
 *       b. `persistInboundMessage` (idempotente por `externalId`);
 *       c. decisão de ticket: se a conversa NÃO tem ticket ATIVO (status ∉
 *          {RESOLVED, CLOSED, CANCELLED}) → cria um ticket vinculado à conversa
 *          + enfileira `OutboxEvent("webhook.dispatch", {event:"ticket.created"})`;
 *          se tem ticket ativo → apenas anexa (a mensagem já ficou vinculada à
 *          conversa; registra um `TicketEvent` "message.received").
 *
 * `companyId` é SEMPRE o da conta resolvida no servidor — nunca confiamos em
 * qualquer valor externo além de servir de checagem de divergência.
 *
 * Dependências injetáveis (para teste): `prisma` e um relógio `now`.
 *
 * _Requisitos: 5.4, 5.5, 5.6, 6.12, 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 10.8, 1.6_
 */

import type { PrismaClient } from "@prisma/client";
import {
  ChannelType,
  Impact,
  MessageType,
  TicketStatus,
  Urgency,
} from "@/lib/domain/enums";
import type { InboundMessage } from "@/lib/domain/types";
import { derivePriority } from "@/lib/engines/priority";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { nextTicketNumber } from "@/lib/tickets/sequence";
import {
  persistInboundMessage,
  upsertConversation,
} from "@/lib/conversations/service";

/** Janela de sessão do WhatsApp: 24h em milissegundos (Req. 10.7). */
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Tamanho máximo do resumo usado como título do ticket. */
const TITLE_SUMMARY_MAX = 80;

/** Título/descrição padrão quando o corpo da mensagem é vazio. */
const DEFAULT_TITLE = "Nova conversa";
const DEFAULT_DESCRIPTION = "(sem conteúdo textual)";

/**
 * Status de ticket considerados INATIVOS (Req. 10.4/10.5). Tickets não possuem
 * estado EXPIRED; tratamos RESOLVED/CLOSED/CANCELLED como inativos, de modo que
 * uma nova mensagem reabre com um novo ticket.
 */
const INACTIVE_TICKET_STATUSES: ReadonlySet<string> = new Set<string>([
  TicketStatus.RESOLVED,
  TicketStatus.CLOSED,
  TicketStatus.CANCELLED,
]);

/** Motivos de descarte/rejeição sinalizados por {@link IngestionError}. */
export type IngestionErrorReason =
  | "ACCOUNT_NOT_RESOLVED"
  | "UNKNOWN_CHANNEL"
  | "TENANT_MISMATCH";

/**
 * Erro tipado de ingestão. As bordas o traduzem em ack/HTTP; o `reason` permite
 * logs seguros SEM PII/segredos (apenas o motivo e ids técnicos).
 */
export class IngestionError extends Error {
  readonly code = "INGESTION_ERROR" as const;
  readonly reason: IngestionErrorReason;

  constructor(reason: IngestionErrorReason, message: string) {
    super(message);
    this.name = "IngestionError";
    this.reason = reason;
    Object.setPrototypeOf(this, IngestionError.prototype);
  }
}

/** Resultado de `route`. */
export interface RouteResult {
  conversationId: string;
  ticketId?: string;
}

/** Cliente Prisma mínimo do qual o router depende (facilita mock/injeção). */
export type RouterPrisma = Pick<
  PrismaClient,
  "channelAccount" | "message" | "queue" | "user" | "$transaction"
>;

/** Dependências injetáveis do router. */
export interface IngestionRouterDeps {
  prisma?: RouterPrisma;
  /** Relógio (para testes determinísticos). Default: `() => new Date()`. */
  now?: () => Date;
}

/** Conjunto de `ChannelType` reconhecidos (canal conhecido — Req. 10.8). */
const KNOWN_CHANNELS: ReadonlySet<string> = new Set<string>(
  Object.values(ChannelType),
);

/** Deriva um título curto a partir do corpo da mensagem. */
function summarize(body: string | undefined): string {
  const trimmed = (body ?? "").trim();
  if (trimmed.length === 0) return DEFAULT_TITLE;
  if (trimmed.length <= TITLE_SUMMARY_MAX) return trimmed;
  return `${trimmed.slice(0, TITLE_SUMMARY_MAX - 1)}…`;
}

/**
 * Roteia uma `InboundMessage` normalizada: resolve tenant, aplica idempotência
 * e cria/atualiza conversa e ticket. Ver o cabeçalho do módulo e o pseudocódigo
 * do design.
 */
export async function route(
  msg: InboundMessage,
  deps: IngestionRouterDeps = {},
): Promise<RouteResult> {
  const prisma = deps.prisma ?? (defaultPrisma as unknown as RouterPrisma);
  const now = deps.now ?? (() => new Date());

  // (1) Resolver a conta de canal (server-side) e o tenant.
  const account = await prisma.channelAccount.findUnique({
    where: { id: msg.channelAccountId },
    select: { id: true, companyId: true, type: true, active: true },
  });

  if (!account) {
    // Conta não resolvida → descarte sem efeitos (Req. 5.5).
    throw new IngestionError(
      "ACCOUNT_NOT_RESOLVED",
      `ChannelAccount não resolvida para channelAccountId=${msg.channelAccountId}`,
    );
  }

  // Canal desconhecido → descarte sem efeitos (Req. 10.8).
  if (!KNOWN_CHANNELS.has(account.type)) {
    throw new IngestionError(
      "UNKNOWN_CHANNEL",
      `Canal desconhecido para channelAccountId=${account.id}`,
    );
  }

  // Divergência de tenant → rejeição (Req. 1.6, 5.5).
  if (account.companyId !== msg.companyId) {
    throw new IngestionError(
      "TENANT_MISMATCH",
      `Divergência de tenant na ingestão para channelAccountId=${account.id}`,
    );
  }

  // A partir daqui, companyId é SEMPRE o da conta resolvida (server-side).
  const companyId = account.companyId;
  const channelType = account.type as ChannelType;

  // (2) Idempotência: (companyId, externalId) já existe? Devolve o vínculo.
  const existingMessage = await prisma.message.findUnique({
    where: { companyId_externalId: { companyId, externalId: msg.externalId } },
    select: {
      conversationId: true,
      conversation: {
        select: {
          tickets: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });

  if (existingMessage) {
    return {
      conversationId: existingMessage.conversationId,
      ticketId: existingMessage.conversation?.tickets[0]?.id,
    };
  }

  // Janela de sessão: WHATSAPP tem janela de 24h (Req. 10.7).
  const hasSessionWindow = channelType === ChannelType.WHATSAPP;
  const windowExpiresAt = hasSessionWindow
    ? new Date(msg.timestamp.getTime() + SESSION_WINDOW_MS)
    : undefined;

  // Fila padrão do tenant (única `isDefault`) usada no roteamento (Req. 11.6).
  const defaultQueue = await prisma.queue.findFirst({
    where: { companyId, isDefault: true },
    select: { id: true },
  });
  const queueId = defaultQueue?.id ?? null;

  // Criador do ticket: um contato externo NÃO é um `User`, mas `Ticket.createdById`
  // é FK obrigatória para `User`. Resolvemos um usuário de sistema do tenant
  // (o mais antigo) para ser o criador de tickets originados por canal. Isso é
  // determinístico e escopado ao tenant. Só é necessário quando de fato vamos
  // criar um ticket (buscado aqui para manter o round-trip fora da transação).
  const systemUser = await prisma.user.findFirst({
    where: { companyId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  // (3) Transação: upsert conversa + persistir mensagem + decidir ticket.
  return prisma.$transaction(async (tx) => {
    // (3a) Upsert de conversa por (contato, canal) com janela de sessão.
    const conversation = await upsertConversation(tx, {
      companyId,
      channelAccountId: account.id,
      contactExternalId: msg.contactExternalId,
      contactName: msg.contactName,
      windowExpiresAt,
    });

    // (3b) Persistir a mensagem (idempotente por externalId).
    const persisted = await persistInboundMessage(
      tx,
      conversation.id,
      companyId,
      msg,
    );

    // Caso raro: outra transação inseriu a mesma mensagem em paralelo. Trata
    // como no-op idempotente devolvendo o ticket ativo mais recente, se houver.
    if (persisted.duplicate) {
      const latestTicket = await tx.ticket.findFirst({
        where: { companyId, conversationId: conversation.id },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      return {
        conversationId: conversation.id,
        ticketId: latestTicket?.id,
      };
    }

    // (3c) Decidir ticket: existe ticket ATIVO para a conversa?
    const activeTicket = await tx.ticket.findFirst({
      where: {
        companyId,
        conversationId: conversation.id,
        status: { notIn: Array.from(INACTIVE_TICKET_STATUSES) as never },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (activeTicket) {
      // Ticket ativo: a mensagem já está vinculada à conversa; anexa um evento
      // ao ticket para registrar o recebimento (Req. 10.5). Nenhum novo ticket.
      await tx.ticketEvent.create({
        data: {
          companyId,
          ticketId: activeTicket.id,
          type: "message.received",
          data: { messageId: persisted.message.id },
        },
      });
      return { conversationId: conversation.id, ticketId: activeTicket.id };
    }

    // Sem ticket ativo: cria um único ticket vinculado à conversa (Req. 10.4).
    if (!systemUser) {
      // Sem usuário no tenant não há criador válido para o ticket; propaga para
      // rollback (nada é criado). Situação de configuração incompleta do tenant.
      throw new IngestionError(
        "ACCOUNT_NOT_RESOLVED",
        `Nenhum usuário de sistema disponível no tenant para criar o ticket`,
      );
    }
    const number = await nextTicketNumber(tx, companyId);
    const priority = derivePriority(Impact.MEDIUM, Urgency.MEDIUM);
    const createdAt = now();

    const ticket = await tx.ticket.create({
      data: {
        number,
        companyId,
        title: summarize(msg.body),
        description:
          (msg.body ?? "").trim().length > 0
            ? (msg.body as string)
            : DEFAULT_DESCRIPTION,
        status: TicketStatus.OPEN,
        impact: Impact.MEDIUM,
        urgency: Urgency.MEDIUM,
        priority,
        origin: channelType,
        // Criador: usuário de sistema do tenant (o contato externo não é `User`).
        createdById: systemUser.id,
        queueId,
        conversationId: conversation.id,
        createdAt,
      },
      select: { id: true },
    });

    // Enfileira o webhook de saída no MESMO tx (outbox transacional).
    await tx.outboxEvent.create({
      data: {
        companyId,
        type: "webhook.dispatch",
        payload: {
          event: "ticket.created",
          ticketId: ticket.id,
          conversationId: conversation.id,
          companyId,
        },
      },
    });

    // Registra o recebimento da primeira mensagem no ticket recém-criado.
    await tx.ticketEvent.create({
      data: {
        companyId,
        ticketId: ticket.id,
        type: "message.received",
        data: { messageId: persisted.message.id },
      },
    });

    return { conversationId: conversation.id, ticketId: ticket.id };
  });
}

/**
 * Fábrica que devolve um objeto compatível com a interface `IngestionRouter` do
 * design, com dependências fixadas por closure.
 */
export function createIngestionRouter(deps: IngestionRouterDeps = {}) {
  return {
    route: (msg: InboundMessage): Promise<RouteResult> => route(msg, deps),
  };
}
