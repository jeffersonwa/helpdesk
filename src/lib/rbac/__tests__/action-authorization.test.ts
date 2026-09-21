/**
 * Testes de enforcement de autorização no BACKEND (tarefa 33.2).
 *
 * As Server Actions do console (queues/catalog/rbac/channels) NUNCA confiam na
 * UI: elas materializam o `SessionUser` com `sessionToUser` (que carrega as
 * `RoleAssignment` do banco) e delegam ao serviço, que aplica
 * `Authorization.assert` ANTES de qualquer efeito.
 *
 * Este teste exercita esse caminho de ponta a ponta ao nível de serviço, com o
 * MESMO `SessionUser` que a action produziria:
 *  - um usuário SEM a permissão exigida → negado (`AuthorizationError`) e
 *    NENHUMA escrita ocorre (independente do que a UI mostrasse). (Req. 2.1, 2.2)
 *  - um usuário COM a permissão no escopo do tenant → a operação prossegue.
 *
 * Tudo com Prisma mockado — sem I/O real.
 *
 * _Requisitos: 2.1, 2.2, 1.3_
 */

import { describe, expect, it, vi } from "vitest";
import { ScopeLevel } from "@/lib/domain/enums";
import { AuthorizationError } from "@/lib/rbac/types";
import { sessionToUser, type SessionUserClient } from "@/lib/rbac/session-user";
import { createQueue, type OrgPrisma } from "@/lib/org/service";

const COMPANY = "co-1";

/** Client para o sessionToUser: devolve as atribuições informadas. */
function sessionClient(assignments: unknown[]): SessionUserClient {
  return {
    roleAssignment: { findMany: vi.fn().mockResolvedValue(assignments) },
  } as unknown as SessionUserClient;
}

describe("Server actions aplicam autorização no backend (Req. 2.2)", () => {
  it("usuário SEM queue.manage é negado e NÃO escreve, mesmo que a UI permitisse", async () => {
    // sessionToUser materializa um user apenas com ticket.read.
    const user = await sessionToUser(
      { user: { id: "u-1", companyId: COMPANY, role: "AGENT" } },
      {
        prisma: sessionClient([
          {
            roleDef: { permissions: [{ action: "ticket.read" }] },
            scopes: [{ level: ScopeLevel.TENANT, refId: null }],
          },
        ]),
      },
    );
    expect(user).not.toBeNull();

    // Prisma de negócio mockado: nenhuma escrita deve ser chamada.
    const count = vi.fn();
    const create = vi.fn();
    const tx = vi.fn();
    const orgPrisma = {
      queue: { count, create },
      $transaction: tx,
    } as unknown as OrgPrisma;

    await expect(
      createQueue(user!, user!.companyId, { name: "Suporte" }, { prisma: orgPrisma }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // Nenhuma leitura de unicidade nem escrita ocorreu (assert falha antes).
    expect(count).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });

  it("usuário COM queue.manage no tenant prossegue (a operação é autorizada)", async () => {
    const user = await sessionToUser(
      { user: { id: "u-2", companyId: COMPANY, role: "ADMIN" } },
      {
        prisma: sessionClient([
          {
            roleDef: { permissions: [{ action: "queue.manage" }] },
            scopes: [{ level: ScopeLevel.TENANT, refId: null }],
          },
        ]),
      },
    );

    const count = vi.fn().mockResolvedValue(0); // nome único
    const create = vi.fn().mockResolvedValue({ id: "q-new" });
    // $transaction executa o callback com um tx que reusa os mesmos delegates.
    const orgPrisma = {
      queue: { count, create },
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ queue: { updateMany: vi.fn(), create } }),
      ),
    } as unknown as OrgPrisma;

    const res = await createQueue(user!, user!.companyId, { name: "Suporte" }, { prisma: orgPrisma });
    expect(res.id).toBe("q-new");
    expect(count).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
