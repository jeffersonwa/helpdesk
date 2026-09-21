"use server";

import {
  KnowledgeBaseService,
  defaultKbClient,
  kbSearchTermSchema,
  type KbClient,
  type KbSearchResult,
} from "@/lib/kb/service";

/**
 * Server Action de busca na base de conhecimento do portal (tarefa 34.1).
 *
 * Envolve `KnowledgeBaseService.search`, que já:
 *  - retorna SOMENTE artigos publicados do tenant (Req. 14.2, 14.3);
 *  - trata acesso cross-tenant como "não encontrado" ao filtrar por
 *    `companyId` (Req. 14.5);
 *  - valida o termo (1–200) e SEMPRE preserva o termo no resultado, inclusive
 *    quando vazio (Req. 14.6, 14.7).
 *
 * Isolamento de tenant: o `companyId` é SEMPRE derivado da sessão do servidor
 * (nunca do formulário/URL) — princípio inviolável (Req. 1.1–1.3, 14.4).
 *
 * @param deps injeção opcional (client Prisma + resolvedor de sessão) para
 *   testes; em produção usa `auth()` e o client padrão.
 */
export async function searchKb(
  rawTerm: string,
  deps: {
    kb?: KbClient;
    getSession?: () => Promise<{ user?: { companyId?: string | null } } | null>;
  } = {},
): Promise<PortalSearchState> {
  const getSession =
    deps.getSession ??
    (async () => {
      // Import dinâmico de `@/lib/auth` para não puxar o runtime do NextAuth no
      // carregamento do módulo (mesma técnica de `session-user.ts`), mantendo os
      // testes que injetam a sessão livres do NextAuth real.
      const { auth } = await import("@/lib/auth");
      return (await auth()) as { user?: { companyId?: string | null } } | null;
    });
  const session = await getSession();
  const companyId = session?.user?.companyId;

  // Fail-closed: sem tenant na sessão não há o que buscar.
  if (!companyId) {
    return { ok: false, term: typeof rawTerm === "string" ? rawTerm : "", error: "Sessão inválida." };
  }

  // Valida o termo preservando-o na resposta em caso de erro (Req. 14.7).
  const parsed = kbSearchTermSchema.safeParse(rawTerm);
  if (!parsed.success) {
    return {
      ok: false,
      term: typeof rawTerm === "string" ? rawTerm : "",
      error: parsed.error.issues[0]?.message ?? "Termo de busca inválido.",
    };
  }

  const client = deps.kb ?? defaultKbClient();
  const result: KbSearchResult = await KnowledgeBaseService.search(
    client,
    companyId,
    parsed.data,
  );

  return { ok: true, ...result };
}

/** Estado devolvido pela Server Action de busca (consumido pelo Client Component). */
export type PortalSearchState =
  | ({ ok: true } & KbSearchResult)
  | { ok: false; term: string; error: string };
