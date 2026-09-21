/**
 * Testes do helper `sessionToUser` (tarefa 33.2).
 *
 * Cobrem:
 *  - Mapeia a sessão + `RoleAssignment` do banco (RoleDef.permissions + scopes)
 *    para um `SessionUser` consumível pelo motor de RBAC.
 *  - `companyId`/`id` vêm da sessão do servidor; a busca é escopada por
 *    `companyId` (isolamento de tenant, Req. 1.3).
 *  - Fail-closed: sessão sem `id`/`companyId` → `null` (sem materializar user).
 *  - `role` desconhecido é normalizado para `CLIENT` (menor privilégio).
 *  - Usuário sem atribuições → `roleAssignments` vazio (o motor nega por padrão).
 *
 * O delegate `roleAssignment.findMany` do Prisma é mockado — sem I/O real.
 *
 * _Requisitos: 2.1, 2.2, 1.1, 1.3_
 */

import { describe, expect, it, vi } from "vitest";
import { Role, ScopeLevel } from "@/lib/domain/enums";
import {
  normalizeRole,
  sessionToUser,
  type RbacSession,
  type SessionUserClient,
} from "@/lib/rbac/session-user";

const COMPANY = "co-1";

function mockClient(findMany: ReturnType<typeof vi.fn>): SessionUserClient {
  return { roleAssignment: { findMany } } as unknown as SessionUserClient;
}

function session(over: Partial<NonNullable<RbacSession["user"]>> = {}): RbacSession {
  return {
    user: { id: "u-1", companyId: COMPANY, role: Role.ADMIN, ...over },
  };
}

describe("sessionToUser — materialização (Req. 2.1, 1.3)", () => {
  it("mapeia sessão + roleAssignments do banco para SessionUser", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        roleDef: { permissions: [{ action: "queue.manage" }, { action: "ticket.read" }] },
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
      {
        roleDef: { permissions: [{ action: "catalog.manage" }] },
        scopes: [{ level: ScopeLevel.QUEUE, refId: "q-1" }],
      },
    ]);
    const user = await sessionToUser(session(), { prisma: mockClient(findMany) });

    expect(user).not.toBeNull();
    expect(user!.id).toBe("u-1");
    expect(user!.companyId).toBe(COMPANY);
    expect(user!.role).toBe(Role.ADMIN);
    expect(user!.roleAssignments).toHaveLength(2);
    expect(user!.roleAssignments[0]).toEqual({
      permissions: ["queue.manage", "ticket.read"],
      scopes: [{ level: ScopeLevel.TENANT, refId: null }],
    });
    expect(user!.roleAssignments[1]).toEqual({
      permissions: ["catalog.manage"],
      scopes: [{ level: ScopeLevel.QUEUE, refId: "q-1" }],
    });
  });

  it("escopa a busca de atribuições por userId + companyId da sessão (Req. 1.3)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await sessionToUser(session(), { prisma: mockClient(findMany) });

    expect(findMany.mock.calls[0][0].where).toEqual({ userId: "u-1", companyId: COMPANY });
  });

  it("usuário sem atribuições → roleAssignments vazio (motor nega por padrão)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const user = await sessionToUser(session(), { prisma: mockClient(findMany) });
    expect(user!.roleAssignments).toEqual([]);
  });

  it("roleDef nulo em uma atribuição → sem permissões nessa atribuição", async () => {
    const findMany = vi.fn().mockResolvedValue([{ roleDef: null, scopes: [] }]);
    const user = await sessionToUser(session(), { prisma: mockClient(findMany) });
    expect(user!.roleAssignments[0]).toEqual({ permissions: [], scopes: [] });
  });
});

describe("sessionToUser — fail-closed", () => {
  it("retorna null quando não há sessão", async () => {
    const findMany = vi.fn();
    const user = await sessionToUser(null, { prisma: mockClient(findMany) });
    expect(user).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("retorna null quando a sessão não tem companyId", async () => {
    const findMany = vi.fn();
    const user = await sessionToUser({ user: { id: "u-1" } }, { prisma: mockClient(findMany) });
    expect(user).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("retorna null quando a sessão não tem id", async () => {
    const findMany = vi.fn();
    const user = await sessionToUser({ user: { companyId: COMPANY } }, { prisma: mockClient(findMany) });
    expect(user).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("normalizeRole — fail-closed", () => {
  it("preserva um role válido", () => {
    expect(normalizeRole("ADMIN")).toBe(Role.ADMIN);
    expect(normalizeRole("SUPERADMIN")).toBe(Role.SUPERADMIN);
  });
  it("normaliza role desconhecido/nulo para CLIENT", () => {
    expect(normalizeRole("HACKER")).toBe(Role.CLIENT);
    expect(normalizeRole(null)).toBe(Role.CLIENT);
    expect(normalizeRole(undefined)).toBe(Role.CLIENT);
  });
});
