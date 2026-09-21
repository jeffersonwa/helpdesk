/**
 * Testes da Server Action de busca da base de conhecimento do portal
 * (tarefa 34.2). Leves, sem render de React: exercitam `searchKb` com um
 * `KbClient` mockado e uma sessão injetada.
 *
 * Cobre:
 *  - somente publicados + escopo de tenant (o `where` sempre carrega
 *    `companyId` da sessão e `published: true`) — Req. 14.4, 14.5;
 *  - busca sem resultados preserva o termo — Req. 14.7;
 *  - artigo de outro tenant não é retornado (cross-tenant → vazio) — Req. 14.5.
 */
import { describe, it, expect, vi } from "vitest";
import { searchKb } from "./actions";
import type { KbClient } from "@/lib/kb/service";

type Article = {
  id: string;
  companyId: string;
  title: string;
  body: string;
  published: boolean;
  categoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Fábrica de artigo com defaults publicados. */
function article(partial: Partial<Article> & Pick<Article, "id" | "companyId" | "title">): Article {
  return {
    body: "corpo",
    published: true,
    categoryId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...partial,
  };
}

/**
 * KbClient em memória que respeita `where.companyId`, `where.published` e o
 * casamento `contains` (insensitive) sobre `title`/`body` — o suficiente para
 * validar o contrato do service através da action.
 */
function makeKbClient(all: Article[]): { client: KbClient; findMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn(async (args: any) => {
    const w = args.where ?? {};
    const term: string | undefined = w.title?.contains ?? w.body?.contains;
    const field: "title" | "body" = w.title?.contains !== undefined ? "title" : "body";
    return all.filter((a) => {
      if (w.companyId && a.companyId !== w.companyId) return false;
      if (w.published !== undefined && a.published !== w.published) return false;
      if (term !== undefined) {
        return a[field].toLowerCase().includes(term.toLowerCase());
      }
      return true;
    });
  });
  const client = { kbArticle: { findMany } } as unknown as KbClient;
  return { client, findMany };
}

const sessionFor = (companyId: string) => async () => ({ user: { companyId } });

describe("searchKb (Server Action do portal)", () => {
  it("retorna apenas artigos publicados do tenant da sessão", async () => {
    const { client, findMany } = makeKbClient([
      article({ id: "a1", companyId: "t1", title: "Reset de senha" }),
      article({ id: "a2", companyId: "t1", title: "Reset de rede", published: false }),
      article({ id: "a3", companyId: "t2", title: "Reset outro tenant" }),
    ]);

    const res = await searchKb("reset", { kb: client, getSession: sessionFor("t1") });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.term).toBe("reset");
    // Só o publicado do tenant t1.
    expect(res.articles.map((a) => a.id)).toEqual(["a1"]);
    // Toda consulta filtrou por companyId + published.
    for (const call of findMany.mock.calls) {
      expect(call[0].where.companyId).toBe("t1");
      expect(call[0].where.published).toBe(true);
    }
  });

  it("preserva o termo quando não há resultados", async () => {
    const { client } = makeKbClient([
      article({ id: "a1", companyId: "t1", title: "Configurar VPN" }),
    ]);

    const res = await searchKb("inexistente", { kb: client, getSession: sessionFor("t1") });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.empty).toBe(true);
    expect(res.articles).toHaveLength(0);
    expect(res.term).toBe("inexistente");
  });

  it("trata artigo de outro tenant como não encontrado (cross-tenant)", async () => {
    const { client } = makeKbClient([
      article({ id: "a3", companyId: "t2", title: "Segredo do tenant 2" }),
    ]);

    // Sessão do tenant t1 buscando um título que só existe em t2.
    const res = await searchKb("segredo", { kb: client, getSession: sessionFor("t1") });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.empty).toBe(true);
    expect(res.articles).toHaveLength(0);
  });

  it("preserva o termo e falha para termo inválido (vazio)", async () => {
    const { client } = makeKbClient([]);
    const res = await searchKb("", { kb: client, getSession: sessionFor("t1") });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.term).toBe("");
    expect(res.error).toBeTruthy();
  });

  it("falha fechado quando a sessão não tem tenant", async () => {
    const { client, findMany } = makeKbClient([
      article({ id: "a1", companyId: "t1", title: "Qualquer" }),
    ]);
    const res = await searchKb("qualquer", { kb: client, getSession: async () => null });
    expect(res.ok).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });
});
