/**
 * OrgCatalogService — CRUD da estrutura organizacional e do catálogo de serviços,
 * com validação hierárquica (tarefa 11.1).
 *
 * Entidades cobertas:
 *  - Organização: OrgUnit (árvore), Department, Team, Queue, TeamMember.
 *  - Catálogo: CatalogService → Category → Subcategory → CategoryItem.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md` (seções
 * "Data Models" e "Design de Baixo Nível") e requirement 11.
 *
 * Regras aplicadas (Req. 11.1–11.7):
 *  - Nome 1–120 caracteres; unicidade por (tipo, tenant) — nome vazio, > 120
 *    caracteres ou duplicado no mesmo tipo+tenant é rejeitado (Req. 11.1, 11.2).
 *  - Árvore de `OrgUnit`: profundidade máxima 10, sem ciclos, `parentId` do mesmo
 *    tenant (Req. 11.3, 11.4).
 *  - Catálogo hierárquico: no máximo 5 níveis (serviço → categoria → subcategoria
 *    → item); cada nível com pai do mesmo tenant (Req. 11.7).
 *  - No máximo UMA `Queue` com `isDefault=true` por tenant. DECISÃO (documentada):
 *    ao marcar uma fila como padrão, as demais do tenant são DESMARCADAS na mesma
 *    transação (last-write-wins), garantindo o invariante "≤ 1 padrão por tenant"
 *    sem rejeitar a operação do administrador (Req. 11.6).
 *  - `TeamMember` sem duplicatas — `@@unique([teamId,userId])` no schema; aqui a
 *    duplicata é traduzida num erro amigável (Req. 11.5).
 *  - TODAS as operações escopadas por `companyId` derivado do servidor; escritas
 *    exigem `Authorization.assert` com a permissão adequada (org.manage /
 *    catalog.manage / queue.manage) ANTES de qualquer efeito (Req. 2.1, 2.7).
 *
 * NOTA de schema: `Subcategory` e `CategoryItem` NÃO possuem coluna `companyId`
 * própria — pertencem ao tenant do ANCESTRAL (`Category.companyId`). O tenant e a
 * unicidade desses níveis são resolvidos SEMPRE através do pai.
 *
 * _Requisitos: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 2.1, 2.7_
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { ResourceRef, SessionUser } from "@/lib/domain/types";
import { Authorization } from "@/lib/rbac/authorization";
import { prisma as defaultPrisma } from "@/lib/prisma";

/** Profundidade máxima da árvore de unidades organizacionais (Req. 11.3). */
export const MAX_ORG_UNIT_DEPTH = 10;

/**
 * Erro de validação de entidade de organização/catálogo. Mensagem indica a
 * causa (Req. 11.2). Nenhuma escrita ocorre quando lançado.
 */
export class OrgValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = "ORG_VALIDATION") {
    super(message);
    this.name = "OrgValidationError";
    this.code = code;
    Object.setPrototypeOf(this, OrgValidationError.prototype);
  }
}

/** Schema de nome: 1–120 caracteres após `trim` (Req. 11.1, 11.2). */
export const nameSchema = z
  .string({ error: "nome é obrigatório" })
  .trim()
  .min(1, "nome é obrigatório")
  .max(120, "nome deve ter no máximo 120 caracteres");

/** Valida um nome; lança {@link OrgValidationError} em falha. Retorna o nome. */
function validateName(name: unknown): string {
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "nome inválido";
    throw new OrgValidationError(first, "ORG_NAME_INVALID");
  }
  return parsed.data;
}

/** Cliente Prisma completo do serviço (injetável para testes). */
export type OrgPrisma = PrismaClient;

/** Constrói um `ResourceRef` genérico de organização/catálogo para autorização. */
function orgRef(companyId: string, type: string, id?: string): ResourceRef {
  return { companyId, type, id };
}

// ===========================================================================
// OrgUnit (árvore, profundidade ≤ 10, sem ciclos, parent do mesmo tenant)
// ===========================================================================

export interface CreateOrgUnitInput {
  name: string;
  parentId?: string | null;
}

/**
 * Valida que `parentId` pertence ao mesmo tenant e que anexar `childId` (que
 * pode ainda não existir, em criação) sob `parentId` não excede a profundidade
 * nem cria ciclo. Lê a cadeia de ancestrais do pai (no máximo 10 saltos).
 *
 * - Se `parentId` for de OUTRO tenant ou inexistente → erro (Req. 11.4).
 * - Se algum ancestral for o próprio `childId` → ciclo → erro (Req. 11.4).
 * - Se a profundidade do pai já for 10 → anexar excederia → erro (Req. 11.3).
 */
async function assertOrgUnitParentValid(
  client: OrgPrisma,
  companyId: string,
  parentId: string,
  childId: string | null,
): Promise<void> {
  let currentId: string | null = parentId;
  let depth = 1; // o pai conta como nível 1 acima do filho
  const seen = new Set<string>();

  while (currentId) {
    if (childId && currentId === childId) {
      throw new OrgValidationError(
        "hierarquia inválida: a operação criaria um ciclo",
        "ORG_UNIT_CYCLE",
      );
    }
    if (seen.has(currentId)) {
      // Ciclo pré-existente na cadeia — trata como violação hierárquica.
      throw new OrgValidationError(
        "hierarquia inválida: ciclo detectado na cadeia de ancestrais",
        "ORG_UNIT_CYCLE",
      );
    }
    seen.add(currentId);

    const node: { companyId: string; parentId: string | null } | null =
      await client.orgUnit.findUnique({
        where: { id: currentId },
        select: { companyId: true, parentId: true },
      });

    if (!node) {
      throw new OrgValidationError(
        "parentId não encontrado",
        "ORG_UNIT_PARENT_NOT_FOUND",
      );
    }
    if (node.companyId !== companyId) {
      throw new OrgValidationError(
        "parentId pertence a outro tenant",
        "ORG_UNIT_PARENT_CROSS_TENANT",
      );
    }

    // Anexar um filho abaixo deste nível resulta em `depth + 1` de altura total
    // a partir da raiz até o novo filho; limite de 10 níveis (Req. 11.3).
    if (depth + 1 > MAX_ORG_UNIT_DEPTH) {
      throw new OrgValidationError(
        `hierarquia inválida: profundidade máxima de ${MAX_ORG_UNIT_DEPTH} níveis excedida`,
        "ORG_UNIT_DEPTH_EXCEEDED",
      );
    }

    currentId = node.parentId;
    depth += 1;
  }
}

/** Garante unicidade de nome por (tipo, tenant). Lança em duplicata. */
async function assertUniqueName(
  count: () => Promise<number>,
  entityLabel: string,
): Promise<void> {
  if ((await count()) > 0) {
    throw new OrgValidationError(
      `já existe ${entityLabel} com este nome neste tenant`,
      "ORG_NAME_DUPLICATE",
    );
  }
}

export async function createOrgUnit(
  user: SessionUser,
  companyId: string,
  input: CreateOrgUnitInput,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  const name = validateName(input.name);
  Authorization.assert(user, "org.manage", orgRef(companyId, "unit"));

  await assertUniqueName(
    () => client.orgUnit.count({ where: { companyId, name } }),
    "unidade organizacional",
  );

  if (input.parentId) {
    await assertOrgUnitParentValid(client, companyId, input.parentId, null);
  }

  const unit = await client.orgUnit.create({
    data: { companyId, name, parentId: input.parentId ?? null },
    select: { id: true },
  });
  return unit;
}

export interface UpdateOrgUnitInput {
  name?: string;
  parentId?: string | null;
}

export async function updateOrgUnit(
  user: SessionUser,
  companyId: string,
  id: string,
  input: UpdateOrgUnitInput,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  Authorization.assert(user, "org.manage", orgRef(companyId, "unit", id));

  const existing = await client.orgUnit.findUnique({
    where: { id },
    select: { companyId: true },
  });
  if (!existing || existing.companyId !== companyId) {
    throw new OrgValidationError("unidade não encontrada", "ORG_UNIT_NOT_FOUND");
  }

  const data: Prisma.OrgUnitUpdateInput = {};
  if (input.name !== undefined) {
    const name = validateName(input.name);
    await assertUniqueName(
      () =>
        client.orgUnit.count({
          where: { companyId, name, id: { not: id } },
        }),
      "unidade organizacional",
    );
    data.name = name;
  }
  if (input.parentId !== undefined) {
    if (input.parentId === null) {
      data.parent = { disconnect: true };
    } else {
      if (input.parentId === id) {
        throw new OrgValidationError(
          "hierarquia inválida: a operação criaria um ciclo",
          "ORG_UNIT_CYCLE",
        );
      }
      await assertOrgUnitParentValid(client, companyId, input.parentId, id);
      data.parent = { connect: { id: input.parentId } };
    }
  }

  const updated = await client.orgUnit.update({
    where: { id },
    data,
    select: { id: true },
  });
  return updated;
}

export async function deleteOrgUnit(
  user: SessionUser,
  companyId: string,
  id: string,
  deps: { prisma?: OrgPrisma } = {},
): Promise<void> {
  const client = deps.prisma ?? defaultPrisma;
  Authorization.assert(user, "org.manage", orgRef(companyId, "unit", id));
  // Escopo por tenant: só apaga se pertencer ao tenant.
  await client.orgUnit.deleteMany({ where: { id, companyId } });
}

// ===========================================================================
// Department
// ===========================================================================

export interface CreateDepartmentInput {
  name: string;
  unitId?: string | null;
}

export async function createDepartment(
  user: SessionUser,
  companyId: string,
  input: CreateDepartmentInput,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  const name = validateName(input.name);
  Authorization.assert(user, "org.manage", orgRef(companyId, "department"));

  await assertUniqueName(
    () => client.department.count({ where: { companyId, name } }),
    "departamento",
  );

  if (input.unitId) {
    const unit = await client.orgUnit.findUnique({
      where: { id: input.unitId },
      select: { companyId: true },
    });
    if (!unit || unit.companyId !== companyId) {
      throw new OrgValidationError(
        "unitId pertence a outro tenant ou não existe",
        "DEPARTMENT_UNIT_CROSS_TENANT",
      );
    }
  }

  return client.department.create({
    data: { companyId, name, unitId: input.unitId ?? null },
    select: { id: true },
  });
}

// ===========================================================================
// Team
// ===========================================================================

export interface CreateTeamInput {
  name: string;
  departmentId?: string | null;
}

export async function createTeam(
  user: SessionUser,
  companyId: string,
  input: CreateTeamInput,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  const name = validateName(input.name);
  Authorization.assert(user, "org.manage", orgRef(companyId, "team"));

  await assertUniqueName(
    () => client.team.count({ where: { companyId, name } }),
    "time",
  );

  if (input.departmentId) {
    const dep = await client.department.findUnique({
      where: { id: input.departmentId },
      select: { companyId: true },
    });
    if (!dep || dep.companyId !== companyId) {
      throw new OrgValidationError(
        "departmentId pertence a outro tenant ou não existe",
        "TEAM_DEPARTMENT_CROSS_TENANT",
      );
    }
  }

  return client.team.create({
    data: { companyId, name, departmentId: input.departmentId ?? null },
    select: { id: true },
  });
}

// ===========================================================================
// TeamMember (add / remove, sem duplicatas)
// ===========================================================================

/**
 * Adiciona um usuário a um time. `@@unique([teamId,userId])` impede duplicatas;
 * aqui a duplicata é traduzida num erro amigável (Req. 11.5). O time e o usuário
 * precisam pertencer ao tenant.
 */
export async function addTeamMember(
  user: SessionUser,
  companyId: string,
  teamId: string,
  userId: string,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  Authorization.assert(user, "org.manage", orgRef(companyId, "team", teamId));

  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { companyId: true },
  });
  if (!team || team.companyId !== companyId) {
    throw new OrgValidationError("time não encontrado", "TEAM_NOT_FOUND");
  }
  const member = await client.user.findUnique({
    where: { id: userId },
    select: { companyId: true },
  });
  if (!member || member.companyId !== companyId) {
    throw new OrgValidationError(
      "usuário pertence a outro tenant ou não existe",
      "TEAM_MEMBER_CROSS_TENANT",
    );
  }

  const existing = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true },
  });
  if (existing) {
    throw new OrgValidationError(
      "este usuário já é membro deste time",
      "TEAM_MEMBER_DUPLICATE",
    );
  }

  return client.teamMember.create({
    data: { teamId, userId },
    select: { id: true },
  });
}

export async function removeTeamMember(
  user: SessionUser,
  companyId: string,
  teamId: string,
  userId: string,
  deps: { prisma?: OrgPrisma } = {},
): Promise<void> {
  const client = deps.prisma ?? defaultPrisma;
  Authorization.assert(user, "org.manage", orgRef(companyId, "team", teamId));

  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { companyId: true },
  });
  if (!team || team.companyId !== companyId) {
    throw new OrgValidationError("time não encontrado", "TEAM_NOT_FOUND");
  }

  await client.teamMember.deleteMany({ where: { teamId, userId } });
}

// ===========================================================================
// Queue (≤ 1 isDefault por tenant)
// ===========================================================================

export interface CreateQueueInput {
  name: string;
  teamId?: string | null;
  isDefault?: boolean;
}

/**
 * Cria uma fila. Se `isDefault` for `true`, DESMARCA as demais filas padrão do
 * tenant na MESMA transação, preservando o invariante "≤ 1 padrão por tenant"
 * (Req. 11.6, decisão documentada no cabeçalho do módulo).
 */
export async function createQueue(
  user: SessionUser,
  companyId: string,
  input: CreateQueueInput,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  const name = validateName(input.name);
  Authorization.assert(user, "queue.manage", orgRef(companyId, "queue"));

  await assertUniqueName(
    () => client.queue.count({ where: { companyId, name } }),
    "fila",
  );

  const isDefault = input.isDefault ?? false;

  return client.$transaction(async (tx) => {
    if (isDefault) {
      // Desmarca qualquer outra fila padrão do tenant (last-write-wins).
      await tx.queue.updateMany({
        where: { companyId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.queue.create({
      data: { companyId, name, teamId: input.teamId ?? null, isDefault },
      select: { id: true },
    });
  });
}

/**
 * Marca uma fila como padrão, desmarcando as demais do tenant na mesma
 * transação (Req. 11.6).
 */
export async function setDefaultQueue(
  user: SessionUser,
  companyId: string,
  queueId: string,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  Authorization.assert(user, "queue.manage", orgRef(companyId, "queue", queueId));

  const queue = await client.queue.findUnique({
    where: { id: queueId },
    select: { companyId: true },
  });
  if (!queue || queue.companyId !== companyId) {
    throw new OrgValidationError("fila não encontrada", "QUEUE_NOT_FOUND");
  }

  return client.$transaction(async (tx) => {
    await tx.queue.updateMany({
      where: { companyId, isDefault: true, id: { not: queueId } },
      data: { isDefault: false },
    });
    return tx.queue.update({
      where: { id: queueId },
      data: { isDefault: true },
      select: { id: true },
    });
  });
}

// ===========================================================================
// Catálogo: CatalogService → Category → Subcategory → CategoryItem
// ===========================================================================

export interface CreateCatalogServiceInput {
  name: string;
  active?: boolean;
}

export async function createCatalogService(
  user: SessionUser,
  companyId: string,
  input: CreateCatalogServiceInput,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  const name = validateName(input.name);
  Authorization.assert(user, "catalog.manage", orgRef(companyId, "category"));

  await assertUniqueName(
    () => client.catalogService.count({ where: { companyId, name } }),
    "serviço de catálogo",
  );

  return client.catalogService.create({
    data: { companyId, name, active: input.active ?? true },
    select: { id: true },
  });
}

export interface CreateCategoryInput {
  name: string;
  serviceId?: string | null;
}

export async function createCategory(
  user: SessionUser,
  companyId: string,
  input: CreateCategoryInput,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  const name = validateName(input.name);
  Authorization.assert(user, "catalog.manage", orgRef(companyId, "category"));

  await assertUniqueName(
    () => client.category.count({ where: { companyId, name } }),
    "categoria",
  );

  if (input.serviceId) {
    const svc = await client.catalogService.findUnique({
      where: { id: input.serviceId },
      select: { companyId: true },
    });
    if (!svc || svc.companyId !== companyId) {
      throw new OrgValidationError(
        "serviceId pertence a outro tenant ou não existe",
        "CATEGORY_SERVICE_CROSS_TENANT",
      );
    }
  }

  return client.category.create({
    data: { companyId, name, serviceId: input.serviceId ?? null },
    select: { id: true },
  });
}

export interface CreateSubcategoryInput {
  name: string;
  categoryId: string;
}

/**
 * Cria uma subcategoria sob uma `Category`. `Subcategory` NÃO tem `companyId`
 * próprio: o tenant e a unicidade são resolvidos via `Category.companyId`.
 * Nível 3 da hierarquia de catálogo (≤ 5 níveis — Req. 11.7).
 */
export async function createSubcategory(
  user: SessionUser,
  companyId: string,
  input: CreateSubcategoryInput,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  const name = validateName(input.name);
  Authorization.assert(user, "catalog.manage", orgRef(companyId, "category"));

  const category = await client.category.findUnique({
    where: { id: input.categoryId },
    select: { companyId: true },
  });
  if (!category || category.companyId !== companyId) {
    throw new OrgValidationError(
      "categoryId pertence a outro tenant ou não existe",
      "SUBCATEGORY_CATEGORY_CROSS_TENANT",
    );
  }

  // Unicidade por nome dentro da MESMA categoria (o tipo, no tenant, é a
  // subcategoria — escopada pela categoria pai).
  const dupe = await client.subcategory.count({
    where: { categoryId: input.categoryId, name },
  });
  if (dupe > 0) {
    throw new OrgValidationError(
      "já existe subcategoria com este nome nesta categoria",
      "ORG_NAME_DUPLICATE",
    );
  }

  return client.subcategory.create({
    data: { categoryId: input.categoryId, name },
    select: { id: true },
  });
}

export interface CreateCategoryItemInput {
  name: string;
  subcategoryId: string;
}

/**
 * Cria um item de categoria sob uma `Subcategory`. Nível 4 (folha) do catálogo
 * (≤ 5 níveis — Req. 11.7). Tenant resolvido via `Subcategory → Category`.
 */
export async function createCategoryItem(
  user: SessionUser,
  companyId: string,
  input: CreateCategoryItemInput,
  deps: { prisma?: OrgPrisma } = {},
): Promise<{ id: string }> {
  const client = deps.prisma ?? defaultPrisma;
  const name = validateName(input.name);
  Authorization.assert(user, "catalog.manage", orgRef(companyId, "category"));

  const sub = await client.subcategory.findUnique({
    where: { id: input.subcategoryId },
    select: { category: { select: { companyId: true } } },
  });
  if (!sub || sub.category.companyId !== companyId) {
    throw new OrgValidationError(
      "subcategoryId pertence a outro tenant ou não existe",
      "CATEGORY_ITEM_SUBCATEGORY_CROSS_TENANT",
    );
  }

  const dupe = await client.categoryItem.count({
    where: { subcategoryId: input.subcategoryId, name },
  });
  if (dupe > 0) {
    throw new OrgValidationError(
      "já existe item com este nome nesta subcategoria",
      "ORG_NAME_DUPLICATE",
    );
  }

  return client.categoryItem.create({
    data: { subcategoryId: input.subcategoryId, name },
    select: { id: true },
  });
}
