/**
 * Motor de autorização (RBAC) — núcleo PURO, FAIL-CLOSED, sem I/O.
 *
 * Implementa o fluxo de decisão da seção "Modelo de RBAC e Autorização" do
 * design. Todas as permissões e escopos são materializados em
 * `SessionUser.roleAssignments` por outra camada; este módulo apenas decide.
 *
 * Princípio inviolável: NEGAR por padrão. Só concede quando TODAS as condições
 * são satisfeitas de forma inequívoca; qualquer ambiguidade → negar.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`.
 * Requisitos: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 1.5.
 */

import { Role, ScopeLevel } from "@/lib/domain/enums";
import type {
  ResourceRef,
  RoleAssignment,
  RoleScope,
  SessionUser,
} from "@/lib/domain/types";
import {
  isKnownPermission,
  isKnownResourceType,
} from "@/lib/rbac/permissions";
import { AuthorizationError, isPlatformOperation } from "@/lib/rbac/types";

/**
 * Verifica se um único escopo COBRE o recurso alvo.
 *
 * Regras (design, passo 5):
 * - `TENANT`: cobre qualquer recurso do tenant (o tenant já foi validado antes).
 * - `refId === null`: cobre todos os recursos daquele nível dentro do tenant.
 * - Nível restrito com `refId`: cobre apenas quando o campo correspondente do
 *   recurso é EXATAMENTE igual ao `refId`. Se o recurso não carrega o campo
 *   daquele nível, o escopo NÃO cobre (fail-closed).
 */
function scopeCovers(scope: RoleScope, resource: ResourceRef): boolean {
  // Um escopo de tenant cobre qualquer recurso do mesmo tenant.
  if (scope.level === ScopeLevel.TENANT) {
    return true;
  }

  // refId nulo cobre todo o nível dentro do tenant.
  if (scope.refId === null) {
    return true;
  }

  // Escopo restrito: o campo correspondente do recurso deve existir e casar.
  const field = resourceFieldForLevel(scope.level, resource);
  // Se o recurso não carrega o campo daquele nível → não cobre (fail-closed).
  if (field === undefined || field === null) {
    return false;
  }
  return field === scope.refId;
}

/**
 * Mapeia o nível de escopo ao campo correspondente do `ResourceRef`.
 * TICKET usa `id` (o próprio identificador do recurso ticket).
 * Retorna `undefined` para níveis sem campo aplicável no recurso.
 */
function resourceFieldForLevel(
  level: ScopeLevel,
  resource: ResourceRef,
): string | undefined {
  switch (level) {
    case ScopeLevel.UNIT:
      return resource.unitId;
    case ScopeLevel.DEPARTMENT:
      return resource.departmentId;
    case ScopeLevel.TEAM:
      return resource.teamId;
    case ScopeLevel.QUEUE:
      return resource.queueId;
    case ScopeLevel.CATEGORY:
      return resource.categoryId;
    case ScopeLevel.TICKET:
      return resource.id;
    case ScopeLevel.TENANT:
      // Tratado antes; nunca alcançado por este caminho.
      return undefined;
    default:
      // Nível desconhecido → sem campo → não cobre (fail-closed).
      return undefined;
  }
}

/**
 * Uma atribuição concede a ação ao recurso quando:
 *  - a ação está entre as permissões da atribuição, E
 *  - ao menos um dos escopos DESSA atribuição cobre o recurso.
 *
 * O escopo que cobre precisa pertencer à mesma atribuição que concede a
 * permissão (não se combinam permissões de uma atribuição com escopos de outra).
 */
function assignmentGrants(
  assignment: RoleAssignment,
  action: string,
  resource: ResourceRef,
): boolean {
  if (!assignment.permissions.includes(action)) {
    return false;
  }
  return assignment.scopes.some((scope) => scopeCovers(scope, resource));
}

/**
 * Decide se `user` pode executar `action` sobre `resource`. FAIL-CLOSED.
 *
 * Fluxo de decisão (design):
 * 1. Isolamento de tenant: se `resource.companyId !== user.companyId`, negar —
 *    EXCETO quando a ação é operação de plataforma marcada E o usuário é
 *    SUPERADMIN (único bypass documentado de tenant). (Req. 1.5, 2.8)
 * 2. Ação desconhecida (fora do catálogo) → negar. (Req. 2.10)
 * 3. Tipo de recurso desconhecido (fora do registro) → negar. (Req. 2.10)
 * 4. Usuário sem atribuições de papel → negar. (Req. 2.9)
 * 5. Alguma atribuição precisa conceder a permissão E ter escopo que cobre o
 *    recurso; caso contrário → negar. (Req. 2.3, 2.4, 2.5, 2.6)
 */
function can(
  user: SessionUser,
  action: string,
  resource: ResourceRef,
): boolean {
  // (2) Ação fora do catálogo → negar por padrão (fail-closed).
  if (!isKnownPermission(action)) {
    return false;
  }

  // (3) Tipo de recurso fora do registro → negar por padrão (fail-closed).
  if (!isKnownResourceType(resource.type)) {
    return false;
  }

  // (1) Isolamento de tenant.
  const sameTenant = resource.companyId === user.companyId;
  if (!sameTenant) {
    // Único bypass: SUPERADMIN de plataforma em operação de plataforma marcada.
    const platformBypass =
      user.role === Role.SUPERADMIN && isPlatformOperation(action);
    if (!platformBypass) {
      return false;
    }
    // Bypass de plataforma concede a operação de plataforma cross-tenant.
    // (SUPERADMIN é a autoridade de plataforma para essas ações marcadas.)
    return true;
  }

  // (4) Usuário sem nenhum papel atribuído → negar.
  if (user.roleAssignments.length === 0) {
    return false;
  }

  // (5) Ao menos uma atribuição concede a permissão com escopo que cobre.
  return user.roleAssignments.some((assignment) =>
    assignmentGrants(assignment, action, resource),
  );
}

/**
 * Igual a {@link can}, mas lança {@link AuthorizationError} quando negado.
 * A borda traduz o erro em `403 Forbidden`. A mensagem é genérica por
 * segurança (não vaza informação do recurso/permissão). (Req. 2.7)
 */
function assert(
  user: SessionUser,
  action: string,
  resource: ResourceRef,
): void {
  if (!can(user, action, resource)) {
    throw new AuthorizationError();
  }
}

/**
 * Implementação da interface `Authorization` do design.
 * Objeto sem estado; seguro para reutilização/compartilhamento.
 */
export const Authorization = {
  can,
  assert,
} as const;

export { AuthorizationError };
