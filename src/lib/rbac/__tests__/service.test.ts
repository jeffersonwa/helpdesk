/**
 * Testes unitários do RbacService (tarefa 32.2).
 *
 * Os delegates `roleDef` e `roleAssignment` do Prisma são mockados — sem I/O
 * real. Cobrem:
 *  - criação inválida rejeitada: sem permissão, nome vazio, permissão
 *    desconhecida, nome duplicado no mesmo tenant (Req. 3.2);
 *  - atribuição duplicada do mesmo papel ao mesmo usuário no mesmo escopo
 *    rejeitada, preservando a existente (Req. 3.5);
 *  - papel global (`companyId` null) tratado como plataforma: só SUPERADMIN
 *    cria; ADMIN de tenant é negado (Req. 3.6);
 *  - criação válida persiste `RoleDef` + `Permission`;
 *  - autorização aplicada: usuário sem `rbac.manage` é negado;
 *  - catálogo de papéis pré-definidos possui os 12 perfis (Req. 3.3).
 *
 * _Requisitos: 3.2, 3.5, 3.6_
 */

import { describe, expect, it, vi } from "vitest";
import { Role, ScopeLevel } from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import { AuthorizationError } from "@/lib/rbac/authorization";
import {
  DEFAULT_ROLE_CATALOG,
  RbacValidationError,
  assignRole,
  createRoleDef,
  seedDefaultRoles,
  type RbacClient,
} from "@/lib/rbac/service";

const COMPANY = "co-1";

/** Admin de tenant com `rbac.manage` no escopo TENANT do tenant corrente. */
function adminUser(companyId = COMPANY): SessionUser {
  return {
    id: "u-admin",
    companyId,
    role: Role.ADMIN,
    roleAssignments: [
      {
        permissions: ["rbac.manage"],
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
    ],
  };
}

/** SUPERADMIN de plataforma (autoridade para papéis globais). */
function superadminUser(companyId = COMPANY): SessionUser {
  return {
    id: "u-super",
    companyId,
    role: Role.SUPERADMIN,
    roleAssignments: [
      {
        permissions: ["rbac.manage"],
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
    ],
  };
}

/** Usuário sem a permissão `rbac.manage`. */
function noPermUser(companyId = COMPANY): SessionUser {
  return {
    id: "u-noperm",
    companyId,
    role: Role.AGENT,
    roleAssignments: [
      {
        permissions: ["ticket.read"],
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
    ],
  };
}

/** Constrói um RbacClient mockado; cada delegate pode ser sobrescrito. */
function mockClient(over: {
  roleDefFindFirst?: ReturnType<typeof vi.fn>;
  roleDefCreate?: ReturnType<typeof vi.fn>;
  raFindMany?: ReturnType<typeof vi.fn>;
  raCreate?: ReturnType<typeof vi.fn>;
} = {}): RbacClient {
  return {
    roleDef: {
      findFirst: over.roleDefFindFirst ?? vi.fn().mockResolvedValue(null),
      create: over.roleDefCreate ?? vi.fn(),
    },
    roleAssignment: {
      findMany: over.raFindMany ?? vi.fn().mockResolvedValue([]),
      create: over.raCreate ?? vi.fn(),
    },
  } as unknown as RbacClient;
}

// ───────────────────────────────────────────────────────────────────────────
// createRoleDef — validação inválida (Req. 3.2)
// ───────────────────────────────────────────────────────────────────────────

describe("createRoleDef — validação (Req. 3.2)", () => {
  it("rejeita criação sem nenhuma permissão (NO_PERMISSIONS), sem persistir", async () => {
    const create = vi.fn();
    const client = mockClient({ roleDefCreate: create });

    await expect(
      createRoleDef(client, adminUser(), COMPANY, {
        name: "Papel sem permissão",
        permissions: [],
      }),
    ).rejects.toMatchObject({ reason: "NO_PERMISSIONS" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejeita nome vazio (EMPTY_NAME), sem persistir", async () => {
    const create = vi.fn();
    const client = mockClient({ roleDefCreate: create });

    await expect(
      createRoleDef(client, adminUser(), COMPANY, {
        name: "   ",
        permissions: ["ticket.read"],
      }),
    ).rejects.toMatchObject({ reason: "EMPTY_NAME" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejeita permissão desconhecida (UNKNOWN_PERMISSION), sem persistir", async () => {
    const create = vi.fn();
    const client = mockClient({ roleDefCreate: create });

    await expect(
      createRoleDef(client, adminUser(), COMPANY, {
        name: "Papel X",
        permissions: ["ticket.read", "nao.existe"],
      }),
    ).rejects.toMatchObject({ reason: "UNKNOWN_PERMISSION" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejeita nome duplicado no mesmo tenant (DUPLICATE_NAME), sem persistir", async () => {
    // findFirst encontra um papel homônimo no tenant → duplicado.
    const findFirst = vi.fn().mockResolvedValue({ id: "role-existing" });
    const create = vi.fn();
    const client = mockClient({
      roleDefFindFirst: findFirst,
      roleDefCreate: create,
    });

    await expect(
      createRoleDef(client, adminUser(), COMPANY, {
        name: "Suporte",
        permissions: ["ticket.read"],
      }),
    ).rejects.toBeInstanceOf(RbacValidationError);
    expect(create).not.toHaveBeenCalled();
    // A checagem de duplicidade escopou por (companyId, name).
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      companyId: COMPANY,
      name: "Suporte",
    });
  });

  it("rejeita mais de 50 escopos (TOO_MANY_SCOPES), sem persistir", async () => {
    const create = vi.fn();
    const client = mockClient({ roleDefCreate: create });
    const scopes = Array.from({ length: 51 }, () => ({
      level: ScopeLevel.QUEUE,
      refId: "q",
    }));

    await expect(
      createRoleDef(client, adminUser(), COMPANY, {
        name: "Papel com muitos escopos",
        permissions: ["ticket.read"],
        scopes,
      }),
    ).rejects.toMatchObject({ reason: "TOO_MANY_SCOPES" });
    expect(create).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// createRoleDef — criação válida persiste RoleDef + Permission
// ───────────────────────────────────────────────────────────────────────────

describe("createRoleDef — criação válida", () => {
  it("persiste RoleDef + permissões e devolve o identificador (Req. 3.1)", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "role-new",
      companyId: COMPANY,
      name: "Suporte N1",
      permissions: [
        { id: "p1", action: "ticket.read" },
        { id: "p2", action: "ticket.update" },
      ],
    });
    const client = mockClient({ roleDefCreate: create });

    const result = await createRoleDef(client, adminUser(), COMPANY, {
      name: "Suporte N1",
      permissions: ["ticket.read", "ticket.update"],
    });

    expect(result.id).toBe("role-new");
    expect(result.permissions.map((p) => p.action)).toEqual([
      "ticket.read",
      "ticket.update",
    ]);
    // Persistiu com companyId derivado do servidor e permissões aninhadas.
    const data = create.mock.calls[0][0].data;
    expect(data.companyId).toBe(COMPANY);
    expect(data.name).toBe("Suporte N1");
    expect(data.permissions.create).toEqual([
      { action: "ticket.read" },
      { action: "ticket.update" },
    ]);
  });

  it("deduplica permissões repetidas antes de persistir", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "role-dedup",
      companyId: COMPANY,
      name: "Dedup",
      permissions: [{ id: "p1", action: "ticket.read" }],
    });
    const client = mockClient({ roleDefCreate: create });

    await createRoleDef(client, adminUser(), COMPANY, {
      name: "Dedup",
      permissions: ["ticket.read", "ticket.read"],
    });

    expect(create.mock.calls[0][0].data.permissions.create).toEqual([
      { action: "ticket.read" },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Autorização aplicada (Req. 2.1)
// ───────────────────────────────────────────────────────────────────────────

describe("createRoleDef — autorização", () => {
  it("nega criação para usuário sem rbac.manage (AuthorizationError), sem tocar o banco", async () => {
    const findFirst = vi.fn();
    const create = vi.fn();
    const client = mockClient({
      roleDefFindFirst: findFirst,
      roleDefCreate: create,
    });

    await expect(
      createRoleDef(client, noPermUser(), COMPANY, {
        name: "Papel",
        permissions: ["ticket.read"],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Papel global — plataforma (Req. 3.6)
// ───────────────────────────────────────────────────────────────────────────

describe("createRoleDef — papel global (companyId null, Req. 3.6)", () => {
  it("SUPERADMIN cria papel global com companyId null", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "role-global",
      companyId: null,
      name: "Papel Global",
      permissions: [{ id: "p1", action: "ticket.read" }],
    });
    const client = mockClient({ roleDefCreate: create });

    const result = await createRoleDef(client, superadminUser(), null, {
      name: "Papel Global",
      permissions: ["ticket.read"],
    });

    expect(result.companyId).toBeNull();
    // Persistiu como global (companyId null).
    expect(create.mock.calls[0][0].data.companyId).toBeNull();
  });

  it("ADMIN de tenant NÃO pode criar papel global (AuthorizationError)", async () => {
    const create = vi.fn();
    const client = mockClient({ roleDefCreate: create });

    await expect(
      createRoleDef(client, adminUser(), null, {
        name: "Papel Global",
        permissions: ["ticket.read"],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(create).not.toHaveBeenCalled();
  });

  it("checagem de duplicidade de papel global escopa por companyId null", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({
      id: "role-global",
      companyId: null,
      name: "Papel Global",
      permissions: [{ id: "p1", action: "ticket.read" }],
    });
    const client = mockClient({
      roleDefFindFirst: findFirst,
      roleDefCreate: create,
    });

    await createRoleDef(client, superadminUser(), null, {
      name: "Papel Global",
      permissions: ["ticket.read"],
    });

    expect(findFirst.mock.calls[0][0].where.companyId).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// assignRole — atribuição duplicada (Req. 3.5)
// ───────────────────────────────────────────────────────────────────────────

describe("assignRole (Req. 3.4, 3.5)", () => {
  it("cria a atribuição vinculando os escopos (Req. 3.4)", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "ra-1",
      companyId: COMPANY,
      userId: "u-target",
      roleDefId: "role-1",
      scopes: [{ id: "s1", level: ScopeLevel.QUEUE, refId: "q-1" }],
    });
    const client = mockClient({ raCreate: create });

    const result = await assignRole(client, adminUser(), COMPANY, {
      userId: "u-target",
      roleDefId: "role-1",
      scopes: [{ level: ScopeLevel.QUEUE, refId: "q-1" }],
    });

    expect(result.id).toBe("ra-1");
    const data = create.mock.calls[0][0].data;
    expect(data.companyId).toBe(COMPANY);
    expect(data.userId).toBe("u-target");
    expect(data.roleDefId).toBe("role-1");
    expect(data.scopes.create).toEqual([
      { level: ScopeLevel.QUEUE, refId: "q-1" },
    ]);
  });

  it("rejeita atribuição duplicada no mesmo escopo, preservando a existente (Req. 3.5)", async () => {
    // Já existe uma atribuição com exatamente o mesmo escopo.
    const findMany = vi.fn().mockResolvedValue([
      { id: "ra-existing", scopes: [{ level: ScopeLevel.QUEUE, refId: "q-1" }] },
    ]);
    const create = vi.fn();
    const client = mockClient({ raFindMany: findMany, raCreate: create });

    await expect(
      assignRole(client, adminUser(), COMPANY, {
        userId: "u-target",
        roleDefId: "role-1",
        scopes: [{ level: ScopeLevel.QUEUE, refId: "q-1" }],
      }),
    ).rejects.toMatchObject({ reason: "DUPLICATE_ASSIGNMENT" });
    // A atribuição existente é preservada (nenhum create).
    expect(create).not.toHaveBeenCalled();
  });

  it("detecção de duplicidade é insensível à ordem dos escopos", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "ra-existing",
        scopes: [
          { level: ScopeLevel.QUEUE, refId: "q-1" },
          { level: ScopeLevel.TEAM, refId: "t-1" },
        ],
      },
    ]);
    const create = vi.fn();
    const client = mockClient({ raFindMany: findMany, raCreate: create });

    await expect(
      assignRole(client, adminUser(), COMPANY, {
        userId: "u-target",
        roleDefId: "role-1",
        // Mesmos escopos, ordem invertida → ainda duplicado.
        scopes: [
          { level: ScopeLevel.TEAM, refId: "t-1" },
          { level: ScopeLevel.QUEUE, refId: "q-1" },
        ],
      }),
    ).rejects.toMatchObject({ reason: "DUPLICATE_ASSIGNMENT" });
    expect(create).not.toHaveBeenCalled();
  });

  it("permite nova atribuição do mesmo papel em escopo DIFERENTE", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "ra-existing", scopes: [{ level: ScopeLevel.QUEUE, refId: "q-1" }] },
    ]);
    const create = vi.fn().mockResolvedValue({
      id: "ra-2",
      companyId: COMPANY,
      userId: "u-target",
      roleDefId: "role-1",
      scopes: [{ id: "s2", level: ScopeLevel.QUEUE, refId: "q-2" }],
    });
    const client = mockClient({ raFindMany: findMany, raCreate: create });

    const result = await assignRole(client, adminUser(), COMPANY, {
      userId: "u-target",
      roleDefId: "role-1",
      scopes: [{ level: ScopeLevel.QUEUE, refId: "q-2" }],
    });

    expect(result.id).toBe("ra-2");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("nega atribuição para usuário sem rbac.manage (AuthorizationError)", async () => {
    const create = vi.fn();
    const client = mockClient({ raCreate: create });

    await expect(
      assignRole(client, noPermUser(), COMPANY, {
        userId: "u-target",
        roleDefId: "role-1",
        scopes: [],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(create).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Catálogo de papéis pré-definidos (Req. 3.3)
// ───────────────────────────────────────────────────────────────────────────

describe("DEFAULT_ROLE_CATALOG / seedDefaultRoles (Req. 3.3)", () => {
  it("cobre exatamente os 12 perfis pré-definidos", () => {
    const roles = DEFAULT_ROLE_CATALOG.map((t) => t.role);
    expect(roles).toEqual([
      Role.SUPERADMIN,
      Role.ADMIN,
      Role.SERVICE_MANAGER,
      Role.SUPERVISOR,
      Role.AGENT,
      Role.SPECIALIST,
      Role.APPROVER,
      Role.AUDITOR,
      Role.READONLY,
      Role.INTEGRATION,
      Role.SERVICE_ACCOUNT,
      Role.CLIENT,
    ]);
  });

  it("todo perfil tem ao menos uma permissão do catálogo (Req. 3.2)", () => {
    for (const tpl of DEFAULT_ROLE_CATALOG) {
      expect(tpl.permissions.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("apenas SUPERADMIN é papel de plataforma (global)", () => {
    const platform = DEFAULT_ROLE_CATALOG.filter((t) => t.platform);
    expect(platform.map((t) => t.role)).toEqual([Role.SUPERADMIN]);
  });

  it("seedDefaultRoles é idempotente: preserva papéis já existentes", async () => {
    // Todos já existem → findFirst sempre devolve um registro; nunca cria.
    const findFirst = vi.fn().mockResolvedValue({
      id: "existing",
      companyId: COMPANY,
      name: "x",
      permissions: [{ id: "p", action: "ticket.read" }],
    });
    const create = vi.fn();
    const client = mockClient({
      roleDefFindFirst: findFirst,
      roleDefCreate: create,
    });

    const results = await seedDefaultRoles(client, superadminUser(), COMPANY);

    expect(results).toHaveLength(DEFAULT_ROLE_CATALOG.length);
    expect(create).not.toHaveBeenCalled();
  });
});
