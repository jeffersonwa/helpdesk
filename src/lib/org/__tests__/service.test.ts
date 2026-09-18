/**
 * Testes unitários do OrgCatalogService (tarefa 11.2).
 *
 * PUROS: sem banco e sem NextAuth. O client Prisma é mockado com pequenos
 * stores em memória onde necessário (ex.: árvore de OrgUnit para detecção de
 * ciclo/profundidade). Cobrem:
 *  - nome inválido/duplicado (Req. 11.2);
 *  - ciclo hierárquico e profundidade em OrgUnit (Req. 11.3, 11.4);
 *  - parentId de outro tenant (Req. 11.4);
 *  - unicidade da fila padrão — ao criar uma nova padrão, as demais são
 *    desmarcadas (Req. 11.6);
 *  - TeamMember duplicado (Req. 11.5);
 *  - autorização no backend (Req. 2.1, 2.7).
 *
 * _Requisitos: 11.2, 11.3, 11.4, 11.5, 11.6, 2.1, 2.7_
 */

import { describe, expect, it, vi } from "vitest";
import { Role, ScopeLevel } from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import { AuthorizationError } from "@/lib/rbac/types";
import {
  addTeamMember,
  createCategory,
  createOrgUnit,
  createQueue,
  MAX_ORG_UNIT_DEPTH,
  OrgValidationError,
  type OrgPrisma,
} from "@/lib/org/service";

const COMPANY = "company-1";

function admin(companyId = COMPANY): SessionUser {
  return {
    id: "u-admin",
    companyId,
    role: Role.ADMIN,
    roleAssignments: [
      {
        permissions: ["org.manage", "catalog.manage", "queue.manage"],
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
    ],
  };
}

function noPerms(companyId = COMPANY): SessionUser {
  return { id: "u-x", companyId, role: Role.CLIENT, roleAssignments: [] };
}

/**
 * Mock de Prisma com uma árvore de OrgUnit em memória. `nodes` mapeia id →
 * { companyId, parentId }. `nameExists` controla o resultado dos `count` de
 * unicidade de nome.
 */
function orgUnitPrisma(opts: {
  nodes?: Record<string, { companyId: string; parentId: string | null }>;
  nameExists?: boolean;
}): OrgPrisma {
  const nodes = opts.nodes ?? {};
  return {
    orgUnit: {
      count: vi.fn(async () => (opts.nameExists ? 1 : 0)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return nodes[where.id] ?? null;
      }),
      create: vi.fn(async () => ({ id: "unit-new" })),
    },
  } as unknown as OrgPrisma;
}

describe("createOrgUnit — nome (Req. 11.2)", () => {
  it("rejeita nome vazio", async () => {
    const prisma = orgUnitPrisma({});
    await expect(
      createOrgUnit(admin(), COMPANY, { name: "   " }, { prisma }),
    ).rejects.toBeInstanceOf(OrgValidationError);
  });

  it("rejeita nome com mais de 120 caracteres", async () => {
    const prisma = orgUnitPrisma({});
    await expect(
      createOrgUnit(admin(), COMPANY, { name: "a".repeat(121) }, { prisma }),
    ).rejects.toBeInstanceOf(OrgValidationError);
  });

  it("rejeita nome duplicado no mesmo tipo+tenant", async () => {
    const prisma = orgUnitPrisma({ nameExists: true });
    await expect(
      createOrgUnit(admin(), COMPANY, { name: "Suporte" }, { prisma }),
    ).rejects.toMatchObject({ code: "ORG_NAME_DUPLICATE" });
  });

  it("aceita nome válido (120 caracteres) sem pai", async () => {
    const prisma = orgUnitPrisma({});
    await expect(
      createOrgUnit(admin(), COMPANY, { name: "b".repeat(120) }, { prisma }),
    ).resolves.toEqual({ id: "unit-new" });
  });
});

describe("createOrgUnit — hierarquia (Req. 11.3, 11.4)", () => {
  it("rejeita parentId de OUTRO tenant", async () => {
    const prisma = orgUnitPrisma({
      nodes: { p1: { companyId: "other-tenant", parentId: null } },
    });
    await expect(
      createOrgUnit(admin(), COMPANY, { name: "Sub", parentId: "p1" }, {
        prisma,
      }),
    ).rejects.toMatchObject({ code: "ORG_UNIT_PARENT_CROSS_TENANT" });
  });

  it("rejeita parentId inexistente", async () => {
    const prisma = orgUnitPrisma({ nodes: {} });
    await expect(
      createOrgUnit(admin(), COMPANY, { name: "Sub", parentId: "ghost" }, {
        prisma,
      }),
    ).rejects.toMatchObject({ code: "ORG_UNIT_PARENT_NOT_FOUND" });
  });

  it("rejeita quando anexar excede a profundidade máxima de 10 níveis", async () => {
    // Cadeia de 10 ancestrais: n1 (raiz) → ... → n10. Anexar um filho sob n10
    // criaria o 11º nível → rejeitar.
    const nodes: Record<string, { companyId: string; parentId: string | null }> =
      {};
    for (let i = 1; i <= MAX_ORG_UNIT_DEPTH; i++) {
      nodes[`n${i}`] = {
        companyId: COMPANY,
        parentId: i === 1 ? null : `n${i - 1}`,
      };
    }
    const prisma = orgUnitPrisma({ nodes });
    await expect(
      createOrgUnit(
        admin(),
        COMPANY,
        { name: "Excede", parentId: `n${MAX_ORG_UNIT_DEPTH}` },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: "ORG_UNIT_DEPTH_EXCEEDED" });
  });

  it("aceita anexar dentro do limite de profundidade", async () => {
    // Cadeia de 3 ancestrais: anexar o 4º nível é permitido (≤ 10).
    const nodes = {
      a1: { companyId: COMPANY, parentId: null },
      a2: { companyId: COMPANY, parentId: "a1" },
      a3: { companyId: COMPANY, parentId: "a2" },
    };
    const prisma = orgUnitPrisma({ nodes });
    await expect(
      createOrgUnit(admin(), COMPANY, { name: "Nivel4", parentId: "a3" }, {
        prisma,
      }),
    ).resolves.toEqual({ id: "unit-new" });
  });

  it("detecta ciclo pré-existente na cadeia de ancestrais", async () => {
    // c1 → c2 → c1 (ciclo). Anexar sob c1 deve detectar o ciclo.
    const nodes = {
      c1: { companyId: COMPANY, parentId: "c2" },
      c2: { companyId: COMPANY, parentId: "c1" },
    };
    const prisma = orgUnitPrisma({ nodes });
    await expect(
      createOrgUnit(admin(), COMPANY, { name: "X", parentId: "c1" }, { prisma }),
    ).rejects.toMatchObject({ code: "ORG_UNIT_CYCLE" });
  });
});

describe("createOrgUnit — autorização (Req. 2.1, 2.7)", () => {
  it("nega usuário sem permissão org.manage", async () => {
    const prisma = orgUnitPrisma({});
    await expect(
      createOrgUnit(noPerms(), COMPANY, { name: "Suporte" }, { prisma }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("nega quando o companyId do recurso difere do tenant do usuário", async () => {
    const prisma = orgUnitPrisma({});
    await expect(
      createOrgUnit(admin("company-A"), "company-B", { name: "Suporte" }, {
        prisma,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("createQueue — fila padrão única por tenant (Req. 11.6)", () => {
  function queuePrisma() {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async () => ({ id: "queue-new" }));
    const count = vi.fn(async () => 0);
    const tx = { queue: { updateMany, create } };
    const prisma = {
      queue: { count },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    } as unknown as OrgPrisma;
    return { prisma, updateMany, create };
  }

  it("ao criar fila padrão, DESMARCA as demais padrão do tenant", async () => {
    const { prisma, updateMany, create } = queuePrisma();
    const res = await createQueue(
      admin(),
      COMPANY,
      { name: "Padrão", isDefault: true },
      { prisma },
    );
    expect(res).toEqual({ id: "queue-new" });
    // Desmarcou as demais antes de criar.
    expect(updateMany).toHaveBeenCalledWith({
      where: { companyId: COMPANY, isDefault: true },
      data: { isDefault: false },
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("ao criar fila NÃO padrão, não desmarca nenhuma", async () => {
    const { prisma, updateMany } = queuePrisma();
    await createQueue(admin(), COMPANY, { name: "Normal" }, { prisma });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("addTeamMember — sem duplicatas (Req. 11.5)", () => {
  function teamPrisma(opts: { memberExists?: boolean }) {
    return {
      team: {
        findUnique: vi.fn(async () => ({ companyId: COMPANY })),
      },
      user: {
        findUnique: vi.fn(async () => ({ companyId: COMPANY })),
      },
      teamMember: {
        findUnique: vi.fn(async () =>
          opts.memberExists ? { id: "tm-1" } : null,
        ),
        create: vi.fn(async () => ({ id: "tm-new" })),
      },
    } as unknown as OrgPrisma;
  }

  it("adiciona membro novo", async () => {
    const prisma = teamPrisma({ memberExists: false });
    await expect(
      addTeamMember(admin(), COMPANY, "team-1", "user-1", { prisma }),
    ).resolves.toEqual({ id: "tm-new" });
  });

  it("rejeita membro duplicado com erro amigável", async () => {
    const prisma = teamPrisma({ memberExists: true });
    await expect(
      addTeamMember(admin(), COMPANY, "team-1", "user-1", { prisma }),
    ).rejects.toMatchObject({ code: "TEAM_MEMBER_DUPLICATE" });
  });

  it("rejeita quando o usuário é de outro tenant", async () => {
    const prisma = {
      team: { findUnique: vi.fn(async () => ({ companyId: COMPANY })) },
      user: { findUnique: vi.fn(async () => ({ companyId: "other" })) },
      teamMember: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(),
      },
    } as unknown as OrgPrisma;
    await expect(
      addTeamMember(admin(), COMPANY, "team-1", "user-1", { prisma }),
    ).rejects.toMatchObject({ code: "TEAM_MEMBER_CROSS_TENANT" });
  });
});

describe("createCategory — parent do catálogo do mesmo tenant (Req. 11.7)", () => {
  it("rejeita serviceId de outro tenant", async () => {
    const prisma = {
      category: { count: vi.fn(async () => 0), create: vi.fn() },
      catalogService: {
        findUnique: vi.fn(async () => ({ companyId: "other" })),
      },
    } as unknown as OrgPrisma;
    await expect(
      createCategory(admin(), COMPANY, { name: "Rede", serviceId: "svc-x" }, {
        prisma,
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_SERVICE_CROSS_TENANT" });
  });

  it("cria categoria com serviço do mesmo tenant", async () => {
    const prisma = {
      category: {
        count: vi.fn(async () => 0),
        create: vi.fn(async () => ({ id: "cat-new" })),
      },
      catalogService: {
        findUnique: vi.fn(async () => ({ companyId: COMPANY })),
      },
    } as unknown as OrgPrisma;
    await expect(
      createCategory(admin(), COMPANY, { name: "Rede", serviceId: "svc-1" }, {
        prisma,
      }),
    ).resolves.toEqual({ id: "cat-new" });
  });
});
