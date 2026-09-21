/**
 * RbacService — CRUD de papéis (`RoleDef`), permissões (`Permission`),
 * escopos (`Scope`) e atribuições (`RoleAssignment`), escopados por tenant.
 *
 * Tarefa 32.1. Fonte autoritativa:
 * `.kiro/specs/helpdesk-omnichannel/design.md` (seção "Modelo de RBAC e
 * Autorização") e requirement 3.
 *
 * Contrato (Req. 3.1–3.6):
 *  - `createRoleDef`: cria um `RoleDef` vinculado ao tenant. Valida nome
 *    (1–100 caracteres), ao menos 1 e no máximo 200 `Permission` (cada uma
 *    do catálogo em `@/lib/rbac/permissions`) e de 0 a 50 `Scope`. Rejeita
 *    (com erro tipado, sem persistir) quando: sem permissão, nome vazio ou
 *    nome já existente no mesmo tenant (Req. 3.1, 3.2). Persiste o `RoleDef`
 *    + suas linhas `Permission` + os `Scope`-template.
 *  - Catálogo de papéis pré-definidos (Req. 3.3): os 12 perfis mapeados a um
 *    conjunto sensato de permissões do catálogo, mais um helper de upsert
 *    idempotente para semeá-los.
 *  - `assignRole`: cria um `RoleAssignment` ligando usuário→papel com os
 *    `Scope` informados. Rejeita atribuição duplicada do mesmo `RoleDef` ao
 *    mesmo usuário no mesmo escopo (Req. 3.4, 3.5).
 *  - `RoleDef` com `companyId` nulo é papel GLOBAL de plataforma (Req. 3.6);
 *    somente o SUPERADMIN de plataforma pode geri-lo.
 *
 * Segurança:
 *  - `companyId` é SEMPRE derivado do servidor (parâmetro), nunca do corpo.
 *  - Toda escrita exige a permissão `rbac.manage` via `Authorization.assert`
 *    ANTES de qualquer efeito. Operações sobre papéis GLOBAIS (companyId null)
 *    são operações de plataforma: apenas SUPERADMIN as autoriza (o bypass de
 *    tenant de `rbac.manage` está marcado em `PLATFORM_OPERATIONS`).
 *
 * _Requisitos: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
 */

import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { Role, ScopeLevel } from "@/lib/domain/enums";
import type { ResourceRef, SessionUser } from "@/lib/domain/types";
import { Authorization } from "@/lib/rbac/authorization";
import { PERMISSIONS, isKnownPermission, type Permission } from "@/lib/rbac/permissions";

/** Tipo de recurso RBAC para papéis. */
const ROLE_RESOURCE_TYPE = "role" as const;
/** Permissão administrativa exigida para toda escrita de RBAC. */
const RBAC_MANAGE = "rbac.manage" as const;

/** Limites de validação (Req. 3.1). */
export const ROLE_NAME_MIN = 1;
export const ROLE_NAME_MAX = 100;
export const ROLE_PERMISSIONS_MIN = 1;
export const ROLE_PERMISSIONS_MAX = 200;
export const ROLE_SCOPES_MIN = 0;
export const ROLE_SCOPES_MAX = 50;

// ───────────────────────────────────────────────────────────────────────────
// Erros tipados
// ───────────────────────────────────────────────────────────────────────────

/**
 * Erro de validação de um `RoleDef`/atribuição. `reason` identifica a violação
 * específica (Req. 3.2 exige indicar o motivo: permissões ausentes, nome vazio
 * ou nome duplicado; e Req. 3.5 exige indicar atribuição duplicada).
 */
export type RbacValidationReason =
  | "EMPTY_NAME"
  | "NAME_TOO_LONG"
  | "NO_PERMISSIONS"
  | "TOO_MANY_PERMISSIONS"
  | "UNKNOWN_PERMISSION"
  | "TOO_MANY_SCOPES"
  | "DUPLICATE_NAME"
  | "DUPLICATE_ASSIGNMENT";

export class RbacValidationError extends Error {
  readonly code = "RBAC_VALIDATION_ERROR" as const;
  readonly reason: RbacValidationReason;

  constructor(reason: RbacValidationReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "RbacValidationError";
    Object.setPrototypeOf(this, RbacValidationError.prototype);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Cliente Prisma mínimo (injetável nos testes)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Delegates do Prisma consumidos pelo serviço. Injetável nos testes (mock) e
 * satisfeito pelo `PrismaClient` real.
 */
export type RbacClient = {
  roleDef: {
    findFirst: PrismaClient["roleDef"]["findFirst"];
    create: PrismaClient["roleDef"]["create"];
  };
  roleAssignment: {
    findMany: PrismaClient["roleAssignment"]["findMany"];
    create: PrismaClient["roleAssignment"]["create"];
  };
};

/** Cliente default (produção). */
export function defaultRbacClient(): RbacClient {
  return defaultPrisma as unknown as RbacClient;
}

// ───────────────────────────────────────────────────────────────────────────
// Tipos de entrada / saída
// ───────────────────────────────────────────────────────────────────────────

/** Escopo-template de um `RoleDef` / escopo de uma atribuição. */
export interface ScopeInput {
  level: ScopeLevel;
  refId?: string | null;
}

/** Entrada de criação de um `RoleDef`. */
export interface CreateRoleDefInput {
  name: string;
  permissions: string[];
  /** Escopos-template do papel (0–50). Default: nenhum. */
  scopes?: ScopeInput[];
}

/** `RoleDef` retornado (campos essenciais). */
export interface RoleDefRow {
  id: string;
  companyId: string | null;
  name: string;
  permissions: { id: string; action: string }[];
}

/** Entrada de atribuição de um `RoleDef` a um usuário. */
export interface AssignRoleInput {
  userId: string;
  roleDefId: string;
  scopes?: ScopeInput[];
}

/** `RoleAssignment` retornado (campos essenciais). */
export interface RoleAssignmentRow {
  id: string;
  companyId: string;
  userId: string;
  roleDefId: string;
  scopes: { id: string; level: ScopeLevel; refId: string | null }[];
}

// ───────────────────────────────────────────────────────────────────────────
// Validação Zod
// ───────────────────────────────────────────────────────────────────────────

const scopeInputSchema = z.object({
  level: z.nativeEnum(ScopeLevel),
  refId: z.string().nullish(),
});

// ───────────────────────────────────────────────────────────────────────────
// Helpers internos
// ───────────────────────────────────────────────────────────────────────────

/**
 * Referência de recurso RBAC para operações sobre papéis.
 *
 * Para papéis do TENANT usamos o `companyId` do usuário — assim a decisão de
 * autorização exige `rbac.manage` no mesmo tenant. Para papéis GLOBAIS
 * (companyId null), a referência é do PRÓPRIO tenant do usuário porém a ação
 * `rbac.manage` é operação de plataforma: apenas SUPERADMIN cruza o tenant
 * (ver {@link assertCanManage}).
 */
function roleResource(companyId: string): ResourceRef {
  return { companyId, type: ROLE_RESOURCE_TYPE };
}

/**
 * Autoriza a escrita de RBAC. `targetCompanyId === null` denota papel GLOBAL de
 * plataforma: exige SUPERADMIN de plataforma (Req. 3.6). Caso contrário, exige
 * `rbac.manage` no tenant do usuário (Req. 2.1). FAIL-CLOSED em qualquer dúvida.
 */
function assertCanManage(user: SessionUser, targetCompanyId: string | null): void {
  if (targetCompanyId === null) {
    // Papel global: somente SUPERADMIN de plataforma pode geri-lo.
    if (user.role !== Role.SUPERADMIN) {
      // Reutiliza o fluxo negador do motor lançando AuthorizationError.
      Authorization.assert(user, RBAC_MANAGE, {
        companyId: "__platform__",
        type: ROLE_RESOURCE_TYPE,
      });
      return;
    }
    // SUPERADMIN em operação de plataforma marcada (rbac.manage) → permitido.
    Authorization.assert(user, RBAC_MANAGE, {
      companyId: "__platform__",
      type: ROLE_RESOURCE_TYPE,
    });
    return;
  }
  // Papel do tenant: exige rbac.manage no mesmo tenant.
  Authorization.assert(user, RBAC_MANAGE, roleResource(targetCompanyId));
}

/** Normaliza os escopos, aplicando `refId` default nulo. */
function normalizeScopes(scopes: ScopeInput[]): { level: ScopeLevel; refId: string | null }[] {
  return scopes.map((s) => ({ level: s.level, refId: s.refId ?? null }));
}

/**
 * Assinatura canônica de um conjunto de escopos, insensível à ordem. Usada para
 * detectar atribuição duplicada "no mesmo escopo" (Req. 3.5).
 */
function scopeSignature(scopes: { level: ScopeLevel; refId: string | null }[]): string {
  return scopes
    .map((s) => `${s.level}:${s.refId ?? "*"}`)
    .sort()
    .join("|");
}

// ───────────────────────────────────────────────────────────────────────────
// createRoleDef (Req. 3.1, 3.2, 3.6)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cria um `RoleDef` escopado ao tenant (ou GLOBAL quando `companyId === null`).
 *
 * Valida nome (1–100), permissões (1–200, todas do catálogo) e escopos (0–50).
 * Rejeita (sem persistir) nome vazio, ausência de permissão e nome duplicado no
 * mesmo tenant. Persiste o `RoleDef` + `Permission` + `Scope`-template.
 * Exige `rbac.manage` (papel global exige SUPERADMIN de plataforma).
 *
 * @throws {RbacValidationError} nas violações de Req. 3.2.
 */
export async function createRoleDef(
  client: RbacClient,
  user: SessionUser,
  companyId: string | null,
  input: CreateRoleDefInput,
): Promise<RoleDefRow> {
  assertCanManage(user, companyId);

  // (1) Nome: 1–100 caracteres, sem espaços marginais.
  const name = (input.name ?? "").trim();
  if (name.length < ROLE_NAME_MIN) {
    throw new RbacValidationError("EMPTY_NAME", "O nome do papel não pode ser vazio.");
  }
  if (name.length > ROLE_NAME_MAX) {
    throw new RbacValidationError(
      "NAME_TOO_LONG",
      `O nome do papel excede ${ROLE_NAME_MAX} caracteres.`,
    );
  }

  // (2) Permissões: 1–200, todas do catálogo, sem duplicatas.
  const permissions = input.permissions ?? [];
  if (permissions.length < ROLE_PERMISSIONS_MIN) {
    throw new RbacValidationError(
      "NO_PERMISSIONS",
      "O papel precisa de ao menos uma permissão.",
    );
  }
  if (permissions.length > ROLE_PERMISSIONS_MAX) {
    throw new RbacValidationError(
      "TOO_MANY_PERMISSIONS",
      `O papel não pode ter mais de ${ROLE_PERMISSIONS_MAX} permissões.`,
    );
  }
  for (const action of permissions) {
    if (!isKnownPermission(action)) {
      throw new RbacValidationError(
        "UNKNOWN_PERMISSION",
        `Permissão desconhecida: ${action}.`,
      );
    }
  }
  const uniquePermissions = [...new Set(permissions)];

  // (3) Escopos: 0–50, níveis válidos.
  const rawScopes = input.scopes ?? [];
  if (rawScopes.length > ROLE_SCOPES_MAX) {
    throw new RbacValidationError(
      "TOO_MANY_SCOPES",
      `O papel não pode ter mais de ${ROLE_SCOPES_MAX} escopos.`,
    );
  }
  // Valida cada escopo-template (nível válido). Os escopos-template do RoleDef
  // NÃO são persistidos isoladamente: no schema, `Scope` pertence a um
  // `RoleAssignment`. Eles são validados aqui (limite 0–50, Req. 3.1) e
  // reaplicados na atribuição (`assignRole`), conforme o design.
  for (const s of rawScopes) {
    scopeInputSchema.parse(s);
  }

  // (4) Nome duplicado no mesmo tenant (companyId null = escopo global).
  const existing = await client.roleDef.findFirst({
    where: { companyId, name },
    select: { id: true },
  });
  if (existing) {
    throw new RbacValidationError(
      "DUPLICATE_NAME",
      `Já existe um papel com o nome "${name}" neste tenant.`,
    );
  }

  // (5) Persistência: RoleDef + Permission (nested).
  const created = await client.roleDef.create({
    data: {
      companyId,
      name,
      permissions: {
        create: uniquePermissions.map((action) => ({ action })),
      },
    },
    select: {
      id: true,
      companyId: true,
      name: true,
      permissions: { select: { id: true, action: true } },
    },
  });

  return created as RoleDefRow;
}

// ───────────────────────────────────────────────────────────────────────────
// assignRole (Req. 3.4, 3.5)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Atribui um `RoleDef` a um usuário criando um `RoleAssignment` com os `Scope`
 * informados. Rejeita atribuição duplicada do mesmo papel ao mesmo usuário no
 * mesmo conjunto de escopos (Req. 3.5), mantendo a atribuição existente.
 * Exige `rbac.manage` no tenant.
 *
 * @throws {RbacValidationError} `DUPLICATE_ASSIGNMENT` quando já existe.
 */
export async function assignRole(
  client: RbacClient,
  user: SessionUser,
  companyId: string,
  input: AssignRoleInput,
): Promise<RoleAssignmentRow> {
  assertCanManage(user, companyId);

  const scopes = normalizeScopes(
    (input.scopes ?? []).map((s) => scopeInputSchema.parse(s)),
  );
  const wantedSignature = scopeSignature(scopes);

  // Detecta atribuição duplicada: mesmo (tenant, usuário, papel) e mesmo
  // conjunto de escopos (insensível à ordem).
  const existing = await client.roleAssignment.findMany({
    where: { companyId, userId: input.userId, roleDefId: input.roleDefId },
    select: {
      id: true,
      scopes: { select: { level: true, refId: true } },
    },
  });
  for (const a of existing) {
    const sig = scopeSignature(
      a.scopes.map((s) => ({ level: s.level as ScopeLevel, refId: s.refId })),
    );
    if (sig === wantedSignature) {
      throw new RbacValidationError(
        "DUPLICATE_ASSIGNMENT",
        "O usuário já possui este papel no mesmo escopo.",
      );
    }
  }

  const created = await client.roleAssignment.create({
    data: {
      companyId,
      userId: input.userId,
      roleDefId: input.roleDefId,
      scopes: {
        create: scopes.map((s) => ({ level: s.level, refId: s.refId })),
      },
    },
    select: {
      id: true,
      companyId: true,
      userId: true,
      roleDefId: true,
      scopes: { select: { id: true, level: true, refId: true } },
    },
  });

  return created as RoleAssignmentRow;
}

// ───────────────────────────────────────────────────────────────────────────
// Papéis pré-definidos (Req. 3.3) — config/seed data
// ───────────────────────────────────────────────────────────────────────────

/**
 * Conjunto de TODAS as permissões do catálogo (usado por perfis abrangentes).
 */
const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS;

/**
 * Catálogo dos 12 perfis pré-definidos (Req. 3.3) mapeados a um conjunto
 * sensato de permissões do catálogo (`@/lib/rbac/permissions`).
 *
 * Esta é CONFIGURAÇÃO / dados de SEED — não são criados automaticamente; um
 * tenant os materializa via {@link seedDefaultRoles} (upsert idempotente).
 *
 *  - `platform: true` denota um papel GLOBAL de plataforma (`companyId` null),
 *    gerível apenas por SUPERADMIN de plataforma (Req. 3.6).
 *  - Perfis sem permissões concretas de escrita (ex.: CLIENT) recebem, no
 *    mínimo, a leitura pertinente — todo papel exige ≥ 1 permissão (Req. 3.2).
 */
export interface DefaultRoleTemplate {
  role: Role;
  /** Nome legível persistido em `RoleDef.name`. */
  name: string;
  /** `true` → papel global de plataforma (`companyId` null). */
  platform: boolean;
  permissions: Permission[];
}

export const DEFAULT_ROLE_CATALOG: readonly DefaultRoleTemplate[] = [
  {
    role: Role.SUPERADMIN,
    name: "Superadmin de plataforma",
    platform: true,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    role: Role.ADMIN,
    name: "Admin de tenant",
    platform: false,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    role: Role.SERVICE_MANAGER,
    name: "Gestor de serviço",
    platform: false,
    permissions: [
      "ticket.create",
      "ticket.read",
      "ticket.update",
      "ticket.assign",
      "conversation.read",
      "conversation.reply",
      "queue.manage",
      "catalog.manage",
      "org.manage",
      "report.view",
      "kb.manage",
      "approval.decide",
    ],
  },
  {
    role: Role.SUPERVISOR,
    name: "Supervisor",
    platform: false,
    permissions: [
      "ticket.create",
      "ticket.read",
      "ticket.update",
      "ticket.assign",
      "conversation.read",
      "conversation.reply",
      "queue.manage",
      "report.view",
    ],
  },
  {
    role: Role.AGENT,
    name: "Agente",
    platform: false,
    permissions: [
      "ticket.create",
      "ticket.read",
      "ticket.update",
      "conversation.read",
      "conversation.reply",
    ],
  },
  {
    role: Role.SPECIALIST,
    name: "Especialista L2/L3",
    platform: false,
    permissions: [
      "ticket.read",
      "ticket.update",
      "ticket.assign",
      "conversation.read",
      "conversation.reply",
      "kb.manage",
    ],
  },
  {
    role: Role.APPROVER,
    name: "Aprovador",
    platform: false,
    permissions: ["ticket.read", "approval.decide"],
  },
  {
    role: Role.AUDITOR,
    name: "Auditor",
    platform: false,
    permissions: ["ticket.read", "report.view", "audit.read"],
  },
  {
    role: Role.READONLY,
    name: "Somente leitura",
    platform: false,
    permissions: ["ticket.read", "conversation.read", "report.view"],
  },
  {
    role: Role.INTEGRATION,
    name: "Conta de integração",
    platform: false,
    permissions: ["ticket.create", "ticket.read", "ticket.update", "webhook.manage"],
  },
  {
    role: Role.SERVICE_ACCOUNT,
    name: "Conta de serviço",
    platform: false,
    permissions: ["ticket.read", "ticket.update", "automation.manage"],
  },
  {
    role: Role.CLIENT,
    name: "Solicitante/Cliente",
    platform: false,
    permissions: ["ticket.create", "ticket.read"],
  },
] as const;

/**
 * Semeia (idempotentemente) os papéis pré-definidos para um tenant.
 *
 * Idempotência: para cada template, verifica por (companyId, name); se já
 * existir, é preservado (não recria). Papéis de plataforma (`platform: true`)
 * são semeados com `companyId` null (globais) — exige SUPERADMIN.
 *
 * @param companyId tenant alvo dos papéis não-plataforma (globais usam null).
 */
export async function seedDefaultRoles(
  client: RbacClient,
  user: SessionUser,
  companyId: string,
): Promise<RoleDefRow[]> {
  const results: RoleDefRow[] = [];
  for (const tpl of DEFAULT_ROLE_CATALOG) {
    const targetCompanyId = tpl.platform ? null : companyId;
    // Upsert idempotente: se já existir por (companyId, name), preserva.
    const existing = await client.roleDef.findFirst({
      where: { companyId: targetCompanyId, name: tpl.name },
      select: {
        id: true,
        companyId: true,
        name: true,
        permissions: { select: { id: true, action: true } },
      },
    });
    if (existing) {
      results.push(existing as RoleDefRow);
      continue;
    }
    const created = await createRoleDef(client, user, targetCompanyId, {
      name: tpl.name,
      permissions: tpl.permissions,
    });
    results.push(created);
  }
  return results;
}

/** Superfície pública do RbacService. */
export const RbacService = {
  createRoleDef,
  assignRole,
  seedDefaultRoles,
  DEFAULT_ROLE_CATALOG,
} as const;
