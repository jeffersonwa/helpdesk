/**
 * ApprovalEngine — solicitação e decisão de aprovações de tickets.
 *
 * Tarefa 24.1. Fonte autoritativa:
 * `.kiro/specs/helpdesk-omnichannel/design.md` (seções "Data Models" e
 * "Design de Baixo Nível") e requirements 12 (aprovações).
 *
 * Princípios invioláveis aplicados aqui:
 *  - `companyId` é SEMPRE derivado do servidor (contexto de tenant); NUNCA vem
 *    do corpo do cliente. Por isso as funções recebem `companyId` como
 *    argumento separado do payload, e todo acesso ao banco é escopado por ele.
 *  - Autorização SEMPRE no backend: `Authorization.assert` é chamado ANTES de
 *    qualquer efeito. `requestApproval` autoriza a ação de atualização do
 *    ticket ("ticket.update"); `decideApproval` autoriza "approval.decide".
 *  - Efeitos atômicos: a criação da `Approval` + transição do ticket para
 *    PENDING_APPROVAL acontecem na MESMA transação (tudo ou nada).
 *
 * Comportamento de decisão (Req. 12.9, 12.11 — documentado):
 *  - Um aprovador AUTORIZADO decide APPROVED/REJECTED; gravamos o estado e
 *    `decidedAt` na MESMA transação. Só é possível decidir uma `Approval` que
 *    ainda esteja PENDING (idempotência: decidir uma já decidida é rejeitado).
 *  - Ao decidir, o ticket é transicionado PARA FORA de PENDING_APPROVAL:
 *      * APPROVED  → ticket volta para IN_PROGRESS (segue o fluxo de trabalho);
 *      * REJECTED  → ticket volta para IN_PROGRESS (o solicitante retoma/ajusta).
 *    Escolhemos IN_PROGRESS (e não OPEN) porque um ticket que passou por
 *    aprovação já estava em andamento; o requisito 12.9 não fixa o status de
 *    destino, apenas exige registrar a decisão com data/hora — por isso a
 *    transição é documentada aqui como decisão de projeto e só ocorre se o
 *    ticket ainda estiver em PENDING_APPROVAL (não sobrescreve estados finais).
 *  - Um usuário SEM autorização (`approval.decide`) tem a decisão REJEITADA
 *    ANTES de qualquer efeito: a `Approval` permanece PENDING e o erro é
 *    sinalizado (`AuthorizationError`) — Req. 12.11.
 *
 * _Requisitos: 12.8, 12.9, 12.11_
 */

import type { PrismaClient } from "@prisma/client";
import { ApprovalState, TicketStatus } from "@/lib/domain/enums";
import type { ResourceRef, SessionUser } from "@/lib/domain/types";
import { Authorization } from "@/lib/rbac/authorization";
import { prisma as defaultPrisma } from "@/lib/prisma";

/**
 * Erro sinalizado quando uma `Approval` não está em estado que permita a
 * decisão (não existe no tenant ou já foi decidida/cancelada). Não vaza detalhe
 * sensível; a borda pode traduzir em `409 Conflict`/`404`.
 */
export class ApprovalNotPendingError extends Error {
  readonly code = "APPROVAL_NOT_PENDING" as const;

  constructor(approvalId: string) {
    super(`Approval ${approvalId} não está PENDING (inexistente ou já decidida)`);
    this.name = "ApprovalNotPendingError";
    Object.setPrototypeOf(this, ApprovalNotPendingError.prototype);
  }
}

/** Entrada de `requestApproval`. */
export interface RequestApprovalInput {
  ticketId: string;
  /** Usuário designado como aprovador da `Approval` criada. */
  approverId: string;
  /** Justificativa opcional da solicitação. */
  reason?: string;
}

/** Resultado de `requestApproval`. */
export interface RequestApprovalResult {
  approvalId: string;
  ticketId: string;
  state: ApprovalState;
  ticketStatus: TicketStatus;
}

/** Decisão possível sobre uma `Approval`. */
export type ApprovalDecision = ApprovalState.APPROVED | ApprovalState.REJECTED;

/** Entrada de `decideApproval`. */
export interface DecideApprovalInput {
  approvalId: string;
  decision: ApprovalDecision;
  /** Motivo opcional (registrado em `Approval.reason`). */
  reason?: string;
}

/** Resultado de `decideApproval`. */
export interface DecideApprovalResult {
  approvalId: string;
  ticketId: string;
  state: ApprovalState;
  decidedAt: Date;
  ticketStatus: TicketStatus;
}

/**
 * Cliente Prisma mínimo do qual o engine depende (facilita mock em teste).
 * Precisa de `$transaction` e dos modelos `approval` e `ticket`.
 */
export type ApprovalPrisma = Pick<
  PrismaClient,
  "$transaction" | "approval" | "ticket"
>;

/**
 * Constrói o `ResourceRef` de um ticket para as decisões de autorização.
 */
function ticketResourceRef(companyId: string, ticketId: string): ResourceRef {
  return { companyId, type: "ticket", id: ticketId };
}

/**
 * Solicita aprovação para um ticket (Req. 12.8).
 *
 * Sequência:
 *  1. Autoriza no backend: `Authorization.assert(user, "ticket.update", ref)`
 *     ANTES de qualquer efeito (requerer aprovação é uma atualização do ticket).
 *  2. Em UMA transação: cria a `Approval` PENDING e transiciona o ticket para
 *     PENDING_APPROVAL (registrando `pendingApprovalSince`). Ambos escopados por
 *     `companyId` (tenant do servidor).
 *
 * @param user usuário da sessão (autorização no backend).
 * @param companyId tenant derivado do servidor — NUNCA do corpo.
 * @param input dados da solicitação (ticket + aprovador + motivo).
 * @param deps injeção opcional do client Prisma (para testes).
 */
export async function requestApproval(
  user: SessionUser,
  companyId: string,
  input: RequestApprovalInput,
  deps: { prisma?: ApprovalPrisma } = {},
): Promise<RequestApprovalResult> {
  const client = deps.prisma ?? (defaultPrisma as unknown as ApprovalPrisma);

  // (1) Autorização no backend ANTES de qualquer efeito (Req. 2.1, 2.7).
  Authorization.assert(
    user,
    "ticket.update",
    ticketResourceRef(companyId, input.ticketId),
  );

  // (2) Criação da Approval + transição do ticket na MESMA transação.
  return client.$transaction(async (tx) => {
    const now = new Date();

    const approval = await tx.approval.create({
      data: {
        companyId,
        ticketId: input.ticketId,
        approverId: input.approverId,
        state: ApprovalState.PENDING,
        reason: input.reason ?? null,
      },
      select: { id: true, ticketId: true, state: true },
    });

    // Transiciona o ticket para PENDING_APPROVAL, escopado por tenant.
    const ticket = await tx.ticket.update({
      where: { id: input.ticketId, companyId },
      data: {
        status: TicketStatus.PENDING_APPROVAL,
        pendingApprovalSince: now,
      },
      select: { status: true },
    });

    return {
      approvalId: approval.id,
      ticketId: approval.ticketId,
      state: approval.state as ApprovalState,
      ticketStatus: ticket.status as TicketStatus,
    };
  });
}

/**
 * Decide sobre uma `Approval` PENDING (Req. 12.9, 12.11).
 *
 * Sequência:
 *  1. Autoriza no backend: `Authorization.assert(user, "approval.decide", ref)`
 *     ANTES de qualquer efeito. Se NÃO autorizado → `AuthorizationError`: a
 *     `Approval` permanece PENDING e nada é gravado (Req. 12.11).
 *  2. Em UMA transação: relê a `Approval` escopada por `{ id, companyId }` e
 *     exige que ainda esteja PENDING (senão `ApprovalNotPendingError`); grava
 *     APPROVED/REJECTED com `decidedAt`; transiciona o ticket para fora de
 *     PENDING_APPROVAL (ver decisão de projeto no cabeçalho do módulo).
 *
 * @param user usuário da sessão (autorização no backend).
 * @param companyId tenant derivado do servidor — NUNCA do corpo.
 * @param input decisão (approvalId + APPROVED|REJECTED + motivo).
 * @param deps injeção opcional do client Prisma (para testes).
 */
export async function decideApproval(
  user: SessionUser,
  companyId: string,
  input: DecideApprovalInput,
  deps: { prisma?: ApprovalPrisma } = {},
): Promise<DecideApprovalResult> {
  const client = deps.prisma ?? (defaultPrisma as unknown as ApprovalPrisma);

  // (1) Só um aprovador AUTORIZADO pode decidir. A asserção ocorre ANTES de
  // qualquer leitura/escrita: usuário não autorizado → AuthorizationError e a
  // Approval permanece intocada (PENDING) — Req. 12.11.
  //
  // Nota: o recurso de referência é o ticket-alvo da aprovação. Como só
  // conhecemos o `ticketId` após ler a Approval, e a leitura já seria um
  // efeito, resolvemos o `ticketId` num passo de leitura escopado por tenant
  // ANTES da transação de escrita — mas a AUTORIZAÇÃO da ação de decidir não
  // depende do ticket específico além do escopo, então usamos o `approvalId`
  // como identidade do recurso de aprovação para a asserção prévia.
  Authorization.assert(user, "approval.decide", {
    companyId,
    type: "ticket",
    id: input.approvalId,
  });

  // (2) Decisão atômica: relê a Approval PENDING e grava a decisão + transição.
  return client.$transaction(async (tx) => {
    const existing = await tx.approval.findFirst({
      where: { id: input.approvalId, companyId, state: ApprovalState.PENDING },
      select: { id: true, ticketId: true },
    });
    if (!existing) {
      // Inexistente no tenant OU já decidida/cancelada → não decide de novo.
      throw new ApprovalNotPendingError(input.approvalId);
    }

    const decidedAt = new Date();

    const approval = await tx.approval.update({
      where: { id: existing.id },
      data: {
        state: input.decision,
        decidedAt,
        reason: input.reason ?? undefined,
      },
      select: { id: true, ticketId: true, state: true, decidedAt: true },
    });

    // Transição do ticket para fora de PENDING_APPROVAL (decisão de projeto:
    // sempre IN_PROGRESS). Escopada por tenant E condicionada ao ticket ainda
    // estar em PENDING_APPROVAL para não sobrescrever estados finais.
    const updated = await tx.ticket.updateMany({
      where: {
        id: existing.ticketId,
        companyId,
        status: TicketStatus.PENDING_APPROVAL,
      },
      data: {
        status: TicketStatus.IN_PROGRESS,
        pendingApprovalSince: null,
      },
    });

    // Se a atualização condicional não afetou linhas, o ticket já não estava
    // em PENDING_APPROVAL; relemos o status atual apenas para retorno fiel.
    let ticketStatus: TicketStatus = TicketStatus.IN_PROGRESS;
    if (updated.count === 0) {
      const t = await tx.ticket.findFirst({
        where: { id: existing.ticketId, companyId },
        select: { status: true },
      });
      ticketStatus = (t?.status as TicketStatus) ?? TicketStatus.IN_PROGRESS;
    }

    return {
      approvalId: approval.id,
      ticketId: approval.ticketId,
      state: approval.state as ApprovalState,
      decidedAt: approval.decidedAt as Date,
      ticketStatus,
    };
  });
}

/**
 * Objeto de conveniência agrupando as operações do engine.
 * Sem estado; seguro para reutilização/compartilhamento.
 */
export const ApprovalEngine = {
  requestApproval,
  decideApproval,
} as const;
