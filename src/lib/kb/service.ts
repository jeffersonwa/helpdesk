/**
 * KnowledgeBaseService — CRUD e busca de artigos (`KbArticle`) da base de
 * conhecimento, escopados por tenant e por publicação.
 *
 * Tarefa 26.1. Fonte autoritativa:
 * `.kiro/specs/helpdesk-omnichannel/design.md` (seção "Portal e Base de
 * Conhecimento") e requirement 14.
 *
 * Contrato (Req. 14.2, 14.3, 14.5, 14.6, 14.7):
 *  - Leituras públicas do portal (`listPublished`, `search`, `getPublishedById`)
 *    retornam SOMENTE artigos `published: true` do tenant corrente. Rascunhos e
 *    arquivados (não publicados) ficam OCULTOS de listagem, busca E acesso
 *    direto por id (Req. 14.3).
 *  - Acesso cross-tenant é tratado como "não encontrado" (`null`), sem revelar
 *    a existência do recurso (Req. 14.5). Isto emerge de filtrar SEMPRE por
 *    `companyId` na cláusula `where`.
 *  - Busca: termo de 1 a 200 caracteres, validado por Zod. Resultados ordenados
 *    por relevância — casamento no `title` acima do casamento no `body`
 *    (ilike, case-insensitive). Busca sem resultados devolve lista vazia
 *    PRESERVANDO o termo consultado (Req. 14.6, 14.7).
 *  - CRUD administrativo (create/update/publish/unpublish/delete) exige a
 *    permissão `kb.manage` via `Authorization.assert` ANTES de qualquer efeito
 *    (Req. 2.1). `companyId` é SEMPRE derivado do servidor pelo chamador.
 *
 * Decisão de relevância (simples, sem full-text nativo):
 *  - Fazemos duas buscas `contains` case-insensitive — uma restrita ao `title`,
 *    outra ao `body` — e concatenamos (title-matches primeiro, depois
 *    body-matches ainda não vistos). Assim um casamento no título é sempre
 *    ranqueado acima de um casamento apenas no corpo. Empates são desempatados
 *    por `updatedAt desc` (mais recente primeiro).
 *
 * _Requisitos: 14.2, 14.3, 14.5, 14.6, 14.7_
 */

import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { Authorization } from "@/lib/rbac/authorization";
import type { ResourceRef, SessionUser } from "@/lib/domain/types";

/** Tipo de recurso RBAC para artigos da base de conhecimento. */
const KB_RESOURCE_TYPE = "kbArticle" as const;
/** Permissão administrativa exigida para CRUD de artigos. */
const KB_MANAGE = "kb.manage" as const;

/** Limites de tamanho do termo de busca (Req. 14.6). */
export const KB_SEARCH_TERM_MIN = 1;
export const KB_SEARCH_TERM_MAX = 200;

/** Validação Zod do termo de busca: 1–200 caracteres (Req. 14.6). */
export const kbSearchTermSchema = z
  .string()
  .min(KB_SEARCH_TERM_MIN, "termo de busca não pode ser vazio")
  .max(KB_SEARCH_TERM_MAX, "termo de busca excede 200 caracteres");

/** Validação de campos ao criar/atualizar um artigo. */
const kbTitleSchema = z.string().min(1, "título obrigatório").max(200);
const kbBodySchema = z.string().min(1, "corpo obrigatório").max(50_000);

/** Artigo retornado pelas leituras (campos essenciais do portal). */
export interface KbArticleRow {
  id: string;
  companyId: string;
  title: string;
  body: string;
  published: boolean;
  categoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Colunas selecionadas em toda leitura de artigo. */
const ARTICLE_SELECT = {
  id: true,
  companyId: true,
  title: true,
  body: true,
  published: true,
  categoryId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Cliente Prisma mínimo consumido pelo serviço — apenas o delegate `kbArticle`.
 * Injetável nos testes (mock) e satisfeito pelo `PrismaClient` real.
 */
export type KbClient = {
  kbArticle: {
    findMany: PrismaClient["kbArticle"]["findMany"];
    findFirst: PrismaClient["kbArticle"]["findFirst"];
    create: PrismaClient["kbArticle"]["create"];
    update: PrismaClient["kbArticle"]["update"];
    delete: PrismaClient["kbArticle"]["delete"];
  };
};

/** Cliente default (produção). */
export function defaultKbClient(): KbClient {
  return defaultPrisma as unknown as KbClient;
}

/** Referência de recurso RBAC para um artigo do tenant. */
function articleResource(companyId: string, id?: string): ResourceRef {
  return { companyId, type: KB_RESOURCE_TYPE, id };
}

// ───────────────────────────────────────────────────────────────────────────
// Leituras públicas do portal (somente publicados, sempre por tenant)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lista artigos PUBLICADOS do tenant, ordenados por atualização mais recente.
 * Rascunhos/arquivados ficam ocultos (Req. 14.2, 14.3).
 */
export async function listPublished(
  client: KbClient,
  companyId: string,
): Promise<KbArticleRow[]> {
  const rows = await client.kbArticle.findMany({
    where: { companyId, published: true },
    orderBy: { updatedAt: "desc" },
    select: ARTICLE_SELECT,
  });
  return rows as KbArticleRow[];
}

/**
 * Acesso direto por id. Devolve o artigo SOMENTE se publicado E do tenant
 * corrente; caso contrário `null` (Req. 14.3 — oculta não publicados; Req. 14.5
 * — cross-tenant tratado como "não encontrado", sem revelar existência).
 */
export async function getPublishedById(
  client: KbClient,
  companyId: string,
  id: string,
): Promise<KbArticleRow | null> {
  const row = await client.kbArticle.findFirst({
    where: { id, companyId, published: true },
    select: ARTICLE_SELECT,
  });
  return (row as KbArticleRow | null) ?? null;
}

/** Resultado de uma busca — sempre preserva o termo informado (Req. 14.7). */
export interface KbSearchResult {
  /** Termo de busca normalizado, preservado mesmo quando não há resultados. */
  term: string;
  /** Artigos publicados do tenant, ordenados por relevância (Req. 14.6). */
  articles: KbArticleRow[];
  /** `true` quando nenhum artigo casou o termo (Req. 14.7). */
  empty: boolean;
}

/**
 * Busca artigos PUBLICADOS do tenant por relevância (Req. 14.6, 14.7).
 *
 * Relevância: casamento no título vem antes de casamento apenas no corpo. Duas
 * consultas `contains` case-insensitive são combinadas nessa ordem. O termo é
 * validado (1–200) e SEMPRE preservado no resultado, mesmo vazio (Req. 14.7).
 *
 * @throws {z.ZodError} se o termo violar os limites de tamanho.
 */
export async function search(
  client: KbClient,
  companyId: string,
  rawTerm: string,
): Promise<KbSearchResult> {
  const term = kbSearchTermSchema.parse(rawTerm);

  // Casamentos no título (maior relevância).
  const titleHits = (await client.kbArticle.findMany({
    where: {
      companyId,
      published: true,
      title: { contains: term, mode: "insensitive" },
    },
    orderBy: { updatedAt: "desc" },
    select: ARTICLE_SELECT,
  })) as KbArticleRow[];

  // Casamentos no corpo (menor relevância).
  const bodyHits = (await client.kbArticle.findMany({
    where: {
      companyId,
      published: true,
      body: { contains: term, mode: "insensitive" },
    },
    orderBy: { updatedAt: "desc" },
    select: ARTICLE_SELECT,
  })) as KbArticleRow[];

  // Concatena title-first e remove duplicatas (título já presente).
  const seen = new Set<string>(titleHits.map((a) => a.id));
  const articles = [...titleHits, ...bodyHits.filter((a) => !seen.has(a.id))];

  return { term, articles, empty: articles.length === 0 };
}

// ───────────────────────────────────────────────────────────────────────────
// CRUD administrativo (exige kb.manage; companyId derivado do servidor)
// ───────────────────────────────────────────────────────────────────────────

/** Entrada de criação de artigo. `companyId` vem do contexto do servidor. */
export interface CreateArticleInput {
  title: string;
  body: string;
  categoryId?: string | null;
  /** Publicado já na criação? Default: rascunho (false). */
  published?: boolean;
}

/**
 * Cria um `KbArticle` no tenant do usuário. Exige `kb.manage` (Req. 2.1).
 * Valida título (1–200) e corpo (1–50.000) por Zod ANTES de persistir.
 */
export async function createArticle(
  client: KbClient,
  user: SessionUser,
  input: CreateArticleInput,
): Promise<KbArticleRow> {
  Authorization.assert(user, KB_MANAGE, articleResource(user.companyId));

  const title = kbTitleSchema.parse(input.title);
  const body = kbBodySchema.parse(input.body);

  const row = await client.kbArticle.create({
    data: {
      companyId: user.companyId,
      title,
      body,
      categoryId: input.categoryId ?? null,
      published: input.published ?? false,
    },
    select: ARTICLE_SELECT,
  });
  return row as KbArticleRow;
}

/** Campos atualizáveis de um artigo (todos opcionais). */
export interface UpdateArticleInput {
  title?: string;
  body?: string;
  categoryId?: string | null;
}

/**
 * Atualiza um artigo do tenant. Exige `kb.manage`. Confirma que o artigo
 * pertence ao tenant (cross-tenant → "não encontrado", Req. 14.5) antes de
 * qualquer escrita. Valida os campos informados por Zod.
 */
export async function updateArticle(
  client: KbClient,
  user: SessionUser,
  id: string,
  input: UpdateArticleInput,
): Promise<KbArticleRow> {
  Authorization.assert(user, KB_MANAGE, articleResource(user.companyId, id));

  await assertOwnedByTenant(client, user.companyId, id);

  const data: {
    title?: string;
    body?: string;
    categoryId?: string | null;
  } = {};
  if (input.title !== undefined) data.title = kbTitleSchema.parse(input.title);
  if (input.body !== undefined) data.body = kbBodySchema.parse(input.body);
  if (input.categoryId !== undefined) data.categoryId = input.categoryId;

  const row = await client.kbArticle.update({
    where: { id },
    data,
    select: ARTICLE_SELECT,
  });
  return row as KbArticleRow;
}

/** Publica um artigo (torna-o visível no portal). Exige `kb.manage`. */
export async function publishArticle(
  client: KbClient,
  user: SessionUser,
  id: string,
): Promise<KbArticleRow> {
  return setPublished(client, user, id, true);
}

/** Despublica um artigo (oculta-o do portal). Exige `kb.manage`. */
export async function unpublishArticle(
  client: KbClient,
  user: SessionUser,
  id: string,
): Promise<KbArticleRow> {
  return setPublished(client, user, id, false);
}

/**
 * Remove um artigo do tenant. Exige `kb.manage`. Confirma posse pelo tenant
 * antes de deletar (cross-tenant → "não encontrado", Req. 14.5).
 */
export async function deleteArticle(
  client: KbClient,
  user: SessionUser,
  id: string,
): Promise<void> {
  Authorization.assert(user, KB_MANAGE, articleResource(user.companyId, id));
  await assertOwnedByTenant(client, user.companyId, id);
  await client.kbArticle.delete({ where: { id } });
}

/** Erro de recurso inexistente/ inacessível (cross-tenant → não encontrado). */
export class KbArticleNotFoundError extends Error {
  readonly code = "KB_ARTICLE_NOT_FOUND" as const;

  constructor() {
    // Mensagem genérica: não revela se o artigo existe em outro tenant (14.5).
    super("Artigo não encontrado");
    this.name = "KbArticleNotFoundError";
    Object.setPrototypeOf(this, KbArticleNotFoundError.prototype);
  }
}

/** Alterna `published` de um artigo do tenant. Exige `kb.manage`. */
async function setPublished(
  client: KbClient,
  user: SessionUser,
  id: string,
  published: boolean,
): Promise<KbArticleRow> {
  Authorization.assert(user, KB_MANAGE, articleResource(user.companyId, id));
  await assertOwnedByTenant(client, user.companyId, id);
  const row = await client.kbArticle.update({
    where: { id },
    data: { published },
    select: ARTICLE_SELECT,
  });
  return row as KbArticleRow;
}

/**
 * Garante que o artigo `id` existe E pertence a `companyId`. Caso contrário
 * lança {@link KbArticleNotFoundError} — inclusive para artigos de outro tenant
 * (cross-tenant tratado como "não encontrado", sem revelar existência, 14.5).
 */
async function assertOwnedByTenant(
  client: KbClient,
  companyId: string,
  id: string,
): Promise<void> {
  const found = await client.kbArticle.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!found) {
    throw new KbArticleNotFoundError();
  }
}

/** Superfície pública do KnowledgeBaseService. */
export const KnowledgeBaseService = {
  listPublished,
  getPublishedById,
  search,
  createArticle,
  updateArticle,
  publishArticle,
  unpublishArticle,
  deleteArticle,
} as const;
