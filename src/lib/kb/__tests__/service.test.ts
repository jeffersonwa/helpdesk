/**
 * Testes unitários do KnowledgeBaseService (tarefa 26.2).
 *
 * O delegate `kbArticle` do Prisma é mockado — sem I/O real. Cobrem:
 *  - rascunho oculto no acesso direto por id (Req. 14.3);
 *  - acesso cross-tenant tratado como "não encontrado" (Req. 14.5);
 *  - busca retorna apenas publicados do tenant, ordenados por relevância
 *    (título acima do corpo) (Req. 14.6);
 *  - busca sem resultados preserva o termo (Req. 14.7);
 *  - publish/unpublish alternam a visibilidade (Req. 14.2/14.3).
 *
 * _Requisitos: 14.3, 14.5, 14.7_
 */

import { describe, expect, it, vi } from "vitest";
import { Role, ScopeLevel } from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import {
  KbArticleNotFoundError,
  createArticle,
  getPublishedById,
  publishArticle,
  search,
  unpublishArticle,
  type KbArticleRow,
  type KbClient,
} from "@/lib/kb/service";

const COMPANY = "co-1";

/** Usuário admin com `kb.manage` no escopo TENANT do tenant corrente. */
function adminUser(companyId = COMPANY): SessionUser {
  return {
    id: "u-admin",
    companyId,
    role: Role.ADMIN,
    roleAssignments: [
      {
        permissions: ["kb.manage"],
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
    ],
  };
}

function makeArticle(over: Partial<KbArticleRow> = {}): KbArticleRow {
  return {
    id: "kb-1",
    companyId: COMPANY,
    title: "Como redefinir a senha",
    body: "Passo a passo para redefinir a senha do portal.",
    published: true,
    categoryId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...over,
  };
}

/** Constrói um KbClient mockado; cada delegate pode ser sobrescrito. */
function mockClient(overrides: Partial<KbClient["kbArticle"]> = {}): KbClient {
  return {
    kbArticle: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      ...overrides,
    },
  } as unknown as KbClient;
}

describe("KnowledgeBaseService.getPublishedById", () => {
  it("oculta rascunho no acesso direto (filtra published=true)", async () => {
    // findFirst com {published:true} não encontra o rascunho → null.
    const findFirst = vi.fn().mockResolvedValue(null);
    const client = mockClient({ findFirst });

    const result = await getPublishedById(client, COMPANY, "kb-draft");

    expect(result).toBeNull();
    // A consulta SEMPRE restringe a published:true e ao tenant.
    const where = findFirst.mock.calls[0][0].where;
    expect(where.published).toBe(true);
    expect(where.companyId).toBe(COMPANY);
    expect(where.id).toBe("kb-draft");
  });

  it("devolve o artigo quando publicado e do tenant", async () => {
    const article = makeArticle();
    const client = mockClient({
      findFirst: vi.fn().mockResolvedValue(article),
    });

    const result = await getPublishedById(client, COMPANY, "kb-1");

    expect(result?.id).toBe("kb-1");
    expect(result?.published).toBe(true);
  });

  it("acesso cross-tenant é tratado como não encontrado (null)", async () => {
    // O artigo existe em OUTRO tenant → o filtro por companyId não o encontra.
    const findFirst = vi.fn().mockResolvedValue(null);
    const client = mockClient({ findFirst });

    const result = await getPublishedById(client, COMPANY, "kb-other-tenant");

    expect(result).toBeNull();
    // Confirma que a consulta escopou por companyId (não revela existência).
    expect(findFirst.mock.calls[0][0].where.companyId).toBe(COMPANY);
  });
});

describe("KnowledgeBaseService.search", () => {
  it("ordena por relevância: título acima do corpo e sem duplicatas", async () => {
    const titleHit = makeArticle({ id: "kb-title", title: "senha reset" });
    const bodyOnly = makeArticle({
      id: "kb-body",
      title: "Outro artigo",
      body: "menciona senha no corpo",
    });
    // findMany é chamado duas vezes: 1) title, 2) body.
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([titleHit])
      .mockResolvedValueOnce([titleHit, bodyOnly]);
    const client = mockClient({ findMany });

    const result = await search(client, COMPANY, "senha");

    expect(result.empty).toBe(false);
    expect(result.term).toBe("senha");
    // title-hit primeiro; body-only depois; sem repetir o title-hit.
    expect(result.articles.map((a) => a.id)).toEqual(["kb-title", "kb-body"]);
    // Ambas as consultas restringem a published:true e ao tenant.
    for (const call of findMany.mock.calls) {
      expect(call[0].where.published).toBe(true);
      expect(call[0].where.companyId).toBe(COMPANY);
    }
  });

  it("busca sem resultados devolve vazio PRESERVANDO o termo (Req. 14.7)", async () => {
    const client = mockClient({
      findMany: vi.fn().mockResolvedValue([]),
    });

    const result = await search(client, COMPANY, "inexistente");

    expect(result.empty).toBe(true);
    expect(result.articles).toEqual([]);
    expect(result.term).toBe("inexistente");
  });

  it("rejeita termo vazio (fora de 1–200) sem tocar o banco", async () => {
    const findMany = vi.fn();
    const client = mockClient({ findMany });

    await expect(search(client, COMPANY, "")).rejects.toBeTruthy();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejeita termo acima de 200 caracteres", async () => {
    const findMany = vi.fn();
    const client = mockClient({ findMany });

    await expect(
      search(client, COMPANY, "x".repeat(201)),
    ).rejects.toBeTruthy();
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("KnowledgeBaseService publish/unpublish", () => {
  it("publish torna o artigo visível (published=true)", async () => {
    const update = vi
      .fn()
      .mockResolvedValue(makeArticle({ published: true }));
    const client = mockClient({
      // assertOwnedByTenant encontra o artigo do tenant.
      findFirst: vi.fn().mockResolvedValue({ id: "kb-1" }),
      update,
    });

    const result = await publishArticle(client, adminUser(), "kb-1");

    expect(result.published).toBe(true);
    expect(update.mock.calls[0][0].data.published).toBe(true);
  });

  it("unpublish oculta o artigo (published=false)", async () => {
    const update = vi
      .fn()
      .mockResolvedValue(makeArticle({ published: false }));
    const client = mockClient({
      findFirst: vi.fn().mockResolvedValue({ id: "kb-1" }),
      update,
    });

    const result = await unpublishArticle(client, adminUser(), "kb-1");

    expect(result.published).toBe(false);
    expect(update.mock.calls[0][0].data.published).toBe(false);
  });

  it("unpublish de artigo de outro tenant → KbArticleNotFoundError (14.5)", async () => {
    const update = vi.fn();
    const client = mockClient({
      // assertOwnedByTenant não encontra no tenant corrente.
      findFirst: vi.fn().mockResolvedValue(null),
      update,
    });

    await expect(
      unpublishArticle(client, adminUser(), "kb-other"),
    ).rejects.toBeInstanceOf(KbArticleNotFoundError);
    // Nenhuma escrita ocorre em recurso cross-tenant.
    expect(update).not.toHaveBeenCalled();
  });
});

describe("KnowledgeBaseService.createArticle (RBAC)", () => {
  it("nega criação sem a permissão kb.manage", async () => {
    const create = vi.fn();
    const client = mockClient({ create });
    const noPerm: SessionUser = {
      id: "u-noperm",
      companyId: COMPANY,
      role: Role.AGENT,
      roleAssignments: [
        {
          permissions: ["ticket.read"],
          scopes: [{ level: ScopeLevel.TENANT, refId: null }],
        },
      ],
    };

    await expect(
      createArticle(client, noPerm, { title: "T", body: "B" }),
    ).rejects.toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("cria como rascunho por padrão (published=false)", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(makeArticle({ id: "kb-new", published: false }));
    const client = mockClient({ create });

    const result = await createArticle(client, adminUser(), {
      title: "Novo artigo",
      body: "Conteúdo do artigo",
    });

    expect(result.id).toBe("kb-new");
    expect(create.mock.calls[0][0].data.published).toBe(false);
    expect(create.mock.calls[0][0].data.companyId).toBe(COMPANY);
  });
});
