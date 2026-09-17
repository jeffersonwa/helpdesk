/**
 * Tipos locais do RBAC além dos tipos de domínio.
 *
 * Os tipos centrais do motor de autorização — `SessionUser`, `RoleAssignment`,
 * `RoleScope`, `ResourceRef` — vivem em `@/lib/domain/types`; `ScopeLevel` e
 * `Role` vivem em `@/lib/domain/enums`. Este módulo NÃO os duplica: apenas
 * re-exporta por conveniência e adiciona o que é específico do motor
 * (o erro de autorização e o marcador de operações de plataforma).
 */

import { Role, ScopeLevel } from "@/lib/domain/enums";
import type {
  ResourceRef,
  RoleAssignment,
  RoleScope,
  SessionUser,
} from "@/lib/domain/types";

// Re-exportações convenientes — a fonte autoritativa continua sendo o domínio.
export { Role, ScopeLevel };
export type { ResourceRef, RoleAssignment, RoleScope, SessionUser };

/**
 * Erro lançado por `Authorization.assert` quando a autorização é negada.
 *
 * SEGURANÇA: a mensagem é intencionalmente genérica e NÃO deve vazar
 * informação sensível (identidade do recurso, permissões avaliadas, tenant,
 * existência do recurso). A borda (edge/route handler) traduz este erro em
 * `403 Forbidden` (Req. 2.7).
 */
export class AuthorizationError extends Error {
  /** Marcador estável para detecção sem depender de `instanceof` entre bundles. */
  readonly code = "AUTHORIZATION_DENIED" as const;

  constructor(message = "Not authorized") {
    super(message);
    this.name = "AuthorizationError";
    // Mantém a cadeia de protótipos correta quando compilado para ES5/ES6.
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}

/**
 * Conjunto de operações de PLATAFORMA explicitamente marcadas.
 *
 * Somente estas ações permitem que um usuário `Role.SUPERADMIN` ignore o
 * isolamento de tenant (cruzar tenants). Qualquer outra ação SEMPRE exige
 * `resource.companyId === user.companyId`, mesmo para SUPERADMIN (Req. 2.8).
 *
 * Este conjunto é deliberadamente restrito a operações inerentemente de
 * plataforma (gestão global de RBAC e configuração de canais). Mantê-lo
 * pequeno é uma decisão de segurança: ampliar o conjunto amplia a superfície
 * de bypass de tenant.
 */
export const PLATFORM_OPERATIONS: ReadonlySet<string> = new Set<string>([
  "rbac.manage",
  "channel.configure",
]);

/**
 * Uma ação é de plataforma se estiver marcada em {@link PLATFORM_OPERATIONS}.
 * Fail-closed: qualquer ação não marcada retorna `false`.
 */
export function isPlatformOperation(action: string): boolean {
  return PLATFORM_OPERATIONS.has(action);
}
