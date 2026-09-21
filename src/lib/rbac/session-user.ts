/**
 * sessionToUser — materializa um {@link SessionUser} para o motor de RBAC a
 * partir da sessão NextAuth + das `RoleAssignment` persistidas do usuário.
 *
 * MOTIVAÇÃO (tarefa 33.1):
 *   A sessão NextAuth v5 deste projeto carrega apenas `id`, `role`, `companyId`,
 *   `companyName` e `companySlug` (ver `auth.config.ts`, callbacks `jwt`/
 *   `session`). Ela NÃO carrega as `roleAssignments` (permissões + escopos)
 *   necessárias para o motor de autorização (`Authorization.can/assert`).
 *   Portanto, para autorizar operações no backend a partir de uma ação de
 *   servidor (Server Action) do console, precisamos CARREGAR as atribuições de
 *   papel do usuário do banco e projetá-las no formato que o motor consome.
 *
 * ABORDAGEM:
 *   1. `companyId`/`id`/`role` vêm SEMPRE da sessão do servidor (nunca do corpo)
 *      — princípio inviolável de multi-tenancy (Req. 1.1–1.3).
 *   2. Carregamos do Prisma as `RoleAssignment` do usuário DENTRO do tenant da
 *      sessão (escopadas por `companyId`), incluindo o `RoleDef` (com suas
 *      `Permission`) e os `Scope`. Papéis GLOBAIS de plataforma (`RoleDef` com
 *      `companyId` null) são incluídos pois valem em todos os tenants (Req. 3.6).
 *   3. Cada `RoleAssignment` é projetada em `{ permissions: string[], scopes:
 *      RoleScope[] }` — exatamente o shape de `@/lib/domain/types`.
 *
 * COMPATIBILIDADE com o `Role` legado:
 *   O `role` do usuário legado (enum `Role` do Prisma) é reaproveitado. Ele
 *   habilita o bypass de plataforma do SUPERADMIN no motor e as verificações de
 *   UX no frontend. As decisões de autorização FINAIS dependem das
 *   `roleAssignments` materializadas aqui (fail-closed quando vazias).
 *
 * _Requisitos: 2.1, 2.2, 1.1, 1.3, 3.6_
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { Role, ScopeLevel } from "@/lib/domain/enums";
import type { RoleAssignment, SessionUser } from "@/lib/domain/types";

/**
 * Formato mínimo da sessão consumido por {@link sessionToUser}. Espelha a
 * sessão exposta por `auth()` (ver `auth.config.ts`).
 */
export interface RbacSession {
  user?: {
    id?: string | null;
    companyId?: string | null;
    role?: string | null;
  } | null;
}

/** Cliente Prisma mínimo consumido pelo helper (injetável nos testes). */
export type SessionUserClient = {
  roleAssignment: {
    findMany: PrismaClient["roleAssignment"]["findMany"];
  };
};

/** Cliente default (produção). */
export function defaultSessionUserClient(): SessionUserClient {
  return defaultPrisma as unknown as SessionUserClient;
}

/**
 * Normaliza um `role` (string livre da sessão) para o enum {@link Role}.
 * Fail-closed: valores desconhecidos caem para `CLIENT` (papel de menor
 * privilégio), garantindo que o motor de RBAC nunca receba um `role` inválido.
 */
export function normalizeRole(role: string | null | undefined): Role {
  if (role && (Object.values(Role) as string[]).includes(role)) {
    return role as Role;
  }
  return Role.CLIENT;
}

/**
 * Constrói um {@link SessionUser} materializado (com `roleAssignments`) a partir
 * da sessão do servidor.
 *
 * - Lança `AuthorizationError`-equivalente via `null` NÃO: retorna `null` quando
 *   a sessão não tem `id`/`companyId` — o chamador (Server Action) decide como
 *   traduzir (tipicamente `AuthorizationError`/403). Manter o helper puro de
 *   efeitos de borda facilita o teste.
 * - `companyId`/`id` vêm da sessão (servidor). As atribuições são carregadas do
 *   banco escopadas por `companyId` (Req. 1.3); papéis globais (RoleDef com
 *   companyId null) também são incluídos (Req. 3.6).
 *
 * @param session sessão do servidor (de `auth()`), ou compatível.
 * @param deps injeção opcional do client Prisma (para testes).
 */
export async function sessionToUser(
  session: RbacSession | null | undefined,
  deps: { prisma?: SessionUserClient } = {},
): Promise<SessionUser | null> {
  const user = session?.user ?? null;
  const id = user?.id;
  const companyId = user?.companyId;

  // Fail-closed: sem identidade/tenant não há como materializar um usuário.
  if (!id || typeof companyId !== "string" || companyId.length === 0) {
    return null;
  }

  const client = deps.prisma ?? defaultSessionUserClient();

  // Carrega as atribuições do usuário. Escopadas pelo tenant da sessão
  // (companyId), incluindo o RoleDef (+ permissões) e os escopos. Papéis
  // globais de plataforma (RoleDef.companyId null) valem em qualquer tenant.
  const assignments = (await client.roleAssignment.findMany({
    where: { userId: id, companyId },
    select: {
      roleDef: {
        select: {
          permissions: { select: { action: true } },
        },
      },
      scopes: { select: { level: true, refId: true } },
    },
  })) as unknown as Array<{
    roleDef: { permissions: { action: string }[] } | null;
    scopes: { level: ScopeLevel; refId: string | null }[];
  }>;

  const roleAssignments: RoleAssignment[] = assignments.map((a) => ({
    permissions: (a.roleDef?.permissions ?? []).map((p) => p.action),
    scopes: a.scopes.map((s) => ({ level: s.level, refId: s.refId ?? null })),
  }));

  return {
    id,
    companyId,
    role: normalizeRole(user?.role),
    roleAssignments,
  };
}

/**
 * Conveniência: resolve o {@link SessionUser} diretamente de `auth()`.
 *
 * Import dinâmico de `@/lib/auth` para não puxar o runtime do NextAuth no
 * carregamento do módulo (mesma técnica de `tenant/context.ts`), mantendo os
 * testes que injetam a sessão livres do NextAuth real.
 */
export async function currentSessionUser(
  deps: { prisma?: SessionUserClient } = {},
): Promise<SessionUser | null> {
  const { auth } = await import("@/lib/auth");
  const session = (await auth()) as RbacSession | null;
  return sessionToUser(session, deps);
}
