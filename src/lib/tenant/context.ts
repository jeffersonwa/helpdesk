/**
 * Helpers de isolamento de tenant (multi-tenancy).
 *
 * Princípio inviolável (design, "Princípios arquiteturais" §1; Req. 1.1–1.4, 1.7):
 * o `companyId` de TODA operação é derivado EXCLUSIVAMENTE da sessão autenticada
 * no SERVIDOR — NUNCA do corpo da requisição do cliente. Qualquer `companyId`
 * enviado pelo cliente é ignorado; a fonte autoritativa é a sessão.
 *
 * Este módulo NÃO faz I/O de negócio: apenas resolve o contexto de tenant a
 * partir da sessão e oferece utilitários para filtrar consultas e comparar
 * tenants. Falhas de tenant são tratadas como negação de autorização
 * (`AuthorizationError`), traduzível em `403` na borda.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`.
 * Requisitos: 1.1, 1.2, 1.3, 1.4, 1.7.
 */

import { AuthorizationError } from "@/lib/rbac/types";

/**
 * Formato mínimo da sessão do qual dependemos para resolver o tenant.
 * Espelha a sessão do NextAuth v5 exposta por `auth()` (ver `auth.config.ts`,
 * callback `session`, que popula `session.user.companyId`).
 */
export interface TenantSession {
  user?: {
    id?: string | null;
    companyId?: string | null;
    role?: string | null;
  } | null;
}

/**
 * Contexto de tenant já validado, pronto para uso em serviços/consultas.
 * `companyId` é garantidamente uma string não-vazia derivada do servidor.
 */
export interface TenantContext {
  companyId: string;
  user: {
    id: string | null;
    companyId: string;
    role: string | null;
  };
}

/**
 * Função que resolve a sessão do lado do servidor.
 * Por padrão usa o `auth()` do NextAuth v5; injetável para testes (sem tocar o
 * NextAuth de verdade) e para reuso em outros contextos de servidor.
 */
export type SessionResolver = () => Promise<TenantSession | null>;

/**
 * Resolvedor padrão: importa `auth()` do NextAuth v5 sob demanda (lazy).
 *
 * O import é dinâmico de propósito: importar `@/lib/auth` no topo do módulo
 * puxa o NextAuth (e seu runtime do Next) já no carregamento, o que quebra em
 * ambientes de teste puro. Fazendo o import só quando o resolvedor padrão é de
 * fato usado, testes que injetam a sessão nunca tocam o NextAuth.
 */
async function defaultSessionResolver(): Promise<TenantSession | null> {
  const { auth } = await import("@/lib/auth");
  return (await auth()) as TenantSession | null;
}

/**
 * Resolve o contexto de tenant a partir da sessão NextAuth no SERVIDOR.
 *
 * Comportamento (Req. 1.1, 1.4):
 * - O `companyId` vem SEMPRE da sessão do servidor; nunca do corpo da requisição.
 * - Se não houver sessão, ou a sessão não tiver `companyId` (nulo/ausente/vazio),
 *   lança {@link AuthorizationError} SEM acessar qualquer entidade de negócio.
 *
 * @param resolveSession resolvedor de sessão (padrão: `auth()` do NextAuth v5).
 *   Parametrizável para permitir testes unitários que mockam a sessão.
 */
export async function getTenantContext(
  resolveSession: SessionResolver = defaultSessionResolver,
): Promise<TenantContext> {
  const session = await resolveSession();
  const user = session?.user ?? null;
  const companyId = user?.companyId;

  // Fail-closed: sessão ausente ou sem companyId → negar antes de qualquer I/O.
  if (!user || typeof companyId !== "string" || companyId.length === 0) {
    throw new AuthorizationError();
  }

  return {
    companyId,
    user: {
      id: user.id ?? null,
      companyId,
      role: user.role ?? null,
    },
  };
}

/**
 * Fragmento de cláusula `where` do Prisma para filtrar por tenant.
 *
 * Reutilizável em consultas/serviços para garantir que só registros do tenant
 * corrente sejam lidos/alterados (Req. 1.3). O `companyId` passado DEVE ter
 * origem no servidor (ex.: {@link getTenantContext}).
 */
export function tenantWhere(companyId: string): { companyId: string } {
  return { companyId };
}

/**
 * Garante que um recurso pertence ao mesmo tenant do contexto.
 *
 * Lança {@link AuthorizationError} quando `resourceCompanyId !== companyId`
 * (Req. 1.5, isolamento de tenant). Como o `companyId` do contexto vem do
 * servidor, isto impede que um `companyId` vindo do cliente ou de um recurso de
 * outro tenant seja usado por engano.
 */
export function assertSameTenant(
  resourceCompanyId: string,
  companyId: string,
): void {
  if (resourceCompanyId !== companyId) {
    throw new AuthorizationError();
  }
}
