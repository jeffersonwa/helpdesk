/**
 * Testes unitários do ApprovalEngine (`requestApproval`, `decideApproval`).
 *
 * Estratégia:
 *  - Prisma é MOCKADO: um fake mínimo de `$transaction` que executa o callback
 *    com um `tx` fake cujos `approval`/`ticket` são spies. Nenhum I/O real.
 *  - Autorização é EXERCIDA DE VERDADE: construímos `SessionUser`s com e sem a
 *    permissão + escopo necessários, de modo que o `Authorization.can` real
 *    decida. Assim validamos o acoplamento engine ↔ RBAC, não um mock de RBAC.
 *
 * Cobre:
 *  - request → cria Approval PENDING e transiciona o ticket p/ PENDING_APPROVAL;
 *  - decide autorizado → APPROVED/REJECTED com `decidedAt` gravado;
 *  - decide NÃO autorizado → AuthorizationError, Approval permanece PENDING
 *    (nenhuma escrita ocorre).
 *
 * _Requisitos: 12.8, 12.9, 12.11_
 */

import { describe, it, expect, vi } from "vitest";

import { ApprovalState, Role, ScopeLevel, TicketStatus } from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import { AuthorizationError } from "@/lib/rbac/authorization";
import {
  requestApproval,
  decideApproval,
  ApprovalNotPendingError,
  type ApprovalPrisma,
} from "@/lib/engines/approval";

const COMPANY = "company-1";

/** SessionUser do MESMO tenant com as permissões dadas em escopo TENANT. */
function userWith(permissions: string[]): SessionUser {
  return {
    id: "u1",
    companyId: COMPANY,
    role: Role.AGENT,
    roleAssignments: [
      {
        permissions,
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
    ],
  };
}

/**
 * Fake de Prisma para o engine. Registra o que foi criado/atualizado e executa
 * o callback de `$transaction` com um `tx` que é o próprio fake.
 *
 * `approvalRow` controla o retorno de `findFirst` (a Approval PENDING relida na
 * decisão); `null` simula "inexistente ou já decidida".
 */
function makeFakePrisma(opts?: {
  approvalRow?: { id: string; ticketId: string } | null;
  ticketUpdateManyCount?: number;
}) {
  const approvalRow =
    opts?.approvalRow === undefined
      ? { id: "appr-1", ticketId: "tk-1" }
      : opts.approvalRow;

  const calls = {
    approvalCreate: vi.fn(),
    approvalUpdate: vi.fn(),
    approvalFindFirst: vi.fn(),
    ticketUpdate: vi.fn(),
    ticketUpdateMany: vi.fn(),
    ticketFindFirst: vi.fn(),
  };

  const tx = {
    approval: {
      create: (args: unknown) => {
        calls.approvalCreate(args);
        const data = (args as { data: Record<string, unknown> }).data;
        return Promise.resolve({
          id: "appr-1",
          ticketId: data.ticketId,
          state: data.state,
        });
      },
      findFirst: (args: unknown) => {
        calls.approvalFindFirst(args);
        return Promise.resolve(approvalRow);
      },
      update: (args: unknown) => {
        calls.approvalUpdate(args);
        const data = (args as { data: Record<string, unknown> }).data;
        return Promise.resolve({
          id: approvalRow?.id ?? "appr-1",
          ticketId: approvalRow?.ticketId ?? "tk-1",
          state: data.state,
          decidedAt: data.decidedAt,
        });
      },
    },
    ticket: {
      update: (args: unknown) => {
        calls.ticketUpdate(args);
        const data = (args as { data: Record<string, unknown> }).data;
        return Promise.resolve({ status: data.status });
      },
      updateMany: (args: unknown) => {
        calls.ticketUpdateMany(args);
        return Promise.resolve({ count: opts?.ticketUpdateManyCount ?? 1 });
      },
      findFirst: (args: unknown) => {
        calls.ticketFindFirst(args);
        return Promise.resolve({ status: TicketStatus.IN_PROGRESS });
      },
    },
  };

  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)),
    approval: tx.approval,
    ticket: tx.ticket,
  } as unknown as ApprovalPrisma;

  return { prisma, calls };
}

describe("ApprovalEngine.requestApproval (Req. 12.8)", () => {
  it("cria Approval PENDING e transiciona o ticket para PENDING_APPROVAL", async () => {
    const { prisma, calls } = makeFakePrisma();
    // Requerer aprovação exige a permissão de atualizar ticket.
    const user = userWith(["ticket.update"]);

    const result = await requestApproval(
      user,
      COMPANY,
      { ticketId: "tk-1", approverId: "boss-1", reason: "acima do limite" },
      { prisma },
    );

    expect(result.state).toBe(ApprovalState.PENDING);
    expect(result.ticketStatus).toBe(TicketStatus.PENDING_APPROVAL);
    expect(result.ticketId).toBe("tk-1");

    // Approval criada como PENDING, escopada por companyId.
    expect(calls.approvalCreate).toHaveBeenCalledTimes(1);
    const createArgs = calls.approvalCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data.companyId).toBe(COMPANY);
    expect(createArgs.data.state).toBe(ApprovalState.PENDING);
    expect(createArgs.data.approverId).toBe("boss-1");

    // Ticket transicionado para PENDING_APPROVAL, escopado por { id, companyId }.
    expect(calls.ticketUpdate).toHaveBeenCalledTimes(1);
    const updArgs = calls.ticketUpdate.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updArgs.where.id).toBe("tk-1");
    expect(updArgs.where.companyId).toBe(COMPANY);
    expect(updArgs.data.status).toBe(TicketStatus.PENDING_APPROVAL);
  });

  it("rejeita quando o usuário não tem 'ticket.update' (nada é escrito)", async () => {
    const { prisma, calls } = makeFakePrisma();
    const user = userWith(["approval.decide"]); // permissão errada p/ requerer

    await expect(
      requestApproval(
        user,
        COMPANY,
        { ticketId: "tk-1", approverId: "boss-1" },
        { prisma },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    expect(calls.approvalCreate).not.toHaveBeenCalled();
    expect(calls.ticketUpdate).not.toHaveBeenCalled();
  });
});

describe("ApprovalEngine.decideApproval (Req. 12.9, 12.11)", () => {
  it("aprovador autorizado registra APPROVED com decidedAt", async () => {
    const { prisma, calls } = makeFakePrisma();
    const user = userWith(["approval.decide"]);

    const result = await decideApproval(
      user,
      COMPANY,
      { approvalId: "appr-1", decision: ApprovalState.APPROVED },
      { prisma },
    );

    expect(result.state).toBe(ApprovalState.APPROVED);
    expect(result.decidedAt).toBeInstanceOf(Date);
    expect(result.ticketStatus).toBe(TicketStatus.IN_PROGRESS);

    // Gravou a decisão com decidedAt.
    expect(calls.approvalUpdate).toHaveBeenCalledTimes(1);
    const updArgs = calls.approvalUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updArgs.data.state).toBe(ApprovalState.APPROVED);
    expect(updArgs.data.decidedAt).toBeInstanceOf(Date);

    // Ticket saiu de PENDING_APPROVAL (transição condicional aplicada).
    expect(calls.ticketUpdateMany).toHaveBeenCalledTimes(1);
    const tArgs = calls.ticketUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(tArgs.where.status).toBe(TicketStatus.PENDING_APPROVAL);
    expect(tArgs.data.status).toBe(TicketStatus.IN_PROGRESS);
  });

  it("aprovador autorizado registra REJECTED com decidedAt", async () => {
    const { prisma, calls } = makeFakePrisma();
    const user = userWith(["approval.decide"]);

    const result = await decideApproval(
      user,
      COMPANY,
      { approvalId: "appr-1", decision: ApprovalState.REJECTED, reason: "fora da política" },
      { prisma },
    );

    expect(result.state).toBe(ApprovalState.REJECTED);
    expect(result.decidedAt).toBeInstanceOf(Date);
    const updArgs = calls.approvalUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updArgs.data.state).toBe(ApprovalState.REJECTED);
    expect(updArgs.data.reason).toBe("fora da política");
  });

  it("usuário SEM autorização é rejeitado e a Approval permanece PENDING", async () => {
    const { prisma, calls } = makeFakePrisma();
    // Sem "approval.decide" — só sabe atualizar tickets.
    const user = userWith(["ticket.update"]);

    await expect(
      decideApproval(
        user,
        COMPANY,
        { approvalId: "appr-1", decision: ApprovalState.APPROVED },
        { prisma },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // NENHUMA leitura/escrita ocorreu: a Approval não foi tocada (segue PENDING).
    expect(calls.approvalFindFirst).not.toHaveBeenCalled();
    expect(calls.approvalUpdate).not.toHaveBeenCalled();
    expect(calls.ticketUpdateMany).not.toHaveBeenCalled();
  });

  it("decidir uma Approval inexistente/já decidida é rejeitado (não redecide)", async () => {
    const { prisma, calls } = makeFakePrisma({ approvalRow: null });
    const user = userWith(["approval.decide"]);

    await expect(
      decideApproval(
        user,
        COMPANY,
        { approvalId: "missing", decision: ApprovalState.APPROVED },
        { prisma },
      ),
    ).rejects.toBeInstanceOf(ApprovalNotPendingError);

    // Consultou a Approval PENDING, mas não gravou decisão nem transição.
    expect(calls.approvalFindFirst).toHaveBeenCalledTimes(1);
    expect(calls.approvalUpdate).not.toHaveBeenCalled();
    expect(calls.ticketUpdateMany).not.toHaveBeenCalled();
  });

  it("cross-tenant: usuário de outro tenant não decide (AuthorizationError)", async () => {
    const { prisma, calls } = makeFakePrisma();
    const foreignUser: SessionUser = {
      ...userWith(["approval.decide"]),
      companyId: "other-tenant",
    };

    await expect(
      decideApproval(
        foreignUser,
        COMPANY,
        { approvalId: "appr-1", decision: ApprovalState.APPROVED },
        { prisma },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    expect(calls.approvalUpdate).not.toHaveBeenCalled();
  });
});
