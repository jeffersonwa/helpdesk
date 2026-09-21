/**
 * AuditService — trilha de auditoria APPEND-ONLY e IMUTÁVEL.
 *
 * Tarefa 25.1. Fonte autoritativa:
 * `.kiro/specs/helpdesk-omnichannel/design.md` (seção "Auditoria e LGPD") e
 * requirement 13 (histórico auditável).
 *
 * Contrato (Req. 13.1, 13.2, 19.2):
 *  - `recordAudit` grava EXATAMENTE UM `AuditLog` por operação sensível
 *    bem-sucedida, com `actor`, `action`, `entityType`, `entityId`,
 *    `before`/`after` (JSON), `ip` e `timestamp` (via `createdAt` default).
 *  - Imutabilidade: o serviço expõe SOMENTE caminhos de APPEND (`recordAudit`)
 *    e LEITURA (`listAudit`). NÃO existe qualquer método de update/delete de
 *    `AuditLog` neste módulo — a única forma de mutar via serviço seria um
 *    método que não existe.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMUTABILIDADE — abordagem em duas camadas (defesa em profundidade):
 *
 *  (1) GUARDA NO CLIENTE (esta camada): a superfície pública do serviço é
 *      deliberadamente reduzida a append + read. Não há `updateAudit` nem
 *      `deleteAudit`. Qualquer tentativa de mutar através do serviço é, por
 *      construção, impossível (o método inexiste). Além disso, expomos
 *      guardas explícitas `rejectAuditMutation()` que LANÇAM
 *      {@link AuditImmutabilityError} — úteis para pontos onde outra camada
 *      pudesse tentar reusar o serviço para update/delete.
 *
 *  (2) PROTEÇÃO NO BANCO (enforcement de produção — fora do escopo do client):
 *      o Prisma NÃO consegue, sozinho, impedir um `UPDATE`/`DELETE` direto na
 *      tabela. A proteção AUTORITATIVA em produção é feita no PostgreSQL:
 *        - REVOGAR os grants de UPDATE/DELETE na tabela `AuditLog` do papel da
 *          aplicação (`REVOKE UPDATE, DELETE ON "AuditLog" FROM app_role;`), OU
 *        - Um TRIGGER `BEFORE UPDATE OR DELETE` que levanta exceção
 *          (`RAISE EXCEPTION 'AuditLog is append-only'`).
 *      Ver a NOTA de migração ao final deste arquivo (a ser materializada como
 *      uma migração SQL dedicada). Esta camada de banco é o que garante a
 *      imutabilidade mesmo contra acesso direto ao banco; a guarda no cliente
 *      é a primeira linha e documenta a intenção.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MINIMIZAÇÃO / PII (Req. 13.6, 19.2): este serviço NÃO sanitiza `before`/
 * `after`. É responsabilidade do CHAMADOR passar objetos já SANITIZADOS —
 * sem segredos e sem PII sensível — antes de auditar. Isto é intencional: a
 * sanitização depende do domínio da operação sensível, então vive no chamador.
 *
 * _Requisitos: 13.1, 13.2, 19.2_
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

/**
 * Erro levantado por {@link rejectAuditMutation}: sinaliza uma tentativa
 * (indevida) de mutar a trilha de auditoria. A borda pode traduzir em `403`.
 */
export class AuditImmutabilityError extends Error {
  readonly code = "AUDIT_IMMUTABLE" as const;

  constructor(operation: "update" | "delete") {
    super(`AuditLog é append-only: ${operation} não é permitido`);
    this.name = "AuditImmutabilityError";
    Object.setPrototypeOf(this, AuditImmutabilityError.prototype);
  }
}

/**
 * Entrada de `recordAudit`. `before`/`after` devem chegar JÁ SANITIZADOS pelo
 * chamador (sem segredos/PII sensível). `actorId`/`ip` são opcionais (ex.:
 * operações de sistema sem ator humano).
 */
export interface RecordAuditInput {
  companyId: string;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  ip?: string | null;
}

/** Registro de auditoria como retornado pela leitura. */
export interface AuditRecord {
  id: string;
  companyId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  ip: string | null;
  createdAt: Date;
}

/**
 * Executor mínimo capaz de CRIAR um `AuditLog`. Aceita tanto o `PrismaClient`
 * quanto um cliente de transação (`Prisma.TransactionClient`) — por isso o
 * append pode participar da MESMA transação da operação sensível (atomicidade:
 * ou a operação e seu audit gravam juntos, ou nada grava).
 */
export type AuditWriter = {
  auditLog: {
    create: PrismaClient["auditLog"]["create"];
  };
};

/** Executor mínimo capaz de LER `AuditLog` (para consultas de auditoria). */
export type AuditReader = {
  auditLog: {
    findMany: PrismaClient["auditLog"]["findMany"];
  };
};

/**
 * Grava EXATAMENTE UM `AuditLog` para uma operação sensível bem-sucedida
 * (Req. 13.1).
 *
 * Aceita `tx` OU `prisma` como primeiro argumento (`AuditWriter`): passe o `tx`
 * da operação sensível para que o audit seja atômico com ela. `createdAt` usa
 * o default do banco (`now()`), servindo de `timestamp` da trilha.
 *
 * NÃO faz autorização nem sanitização: é uma primitiva de escrita chamada por
 * serviços que já autorizaram e já sanitizaram `before`/`after`.
 *
 * @returns o `AuditRecord` recém-criado (útil para asserções/rastreio).
 */
export async function recordAudit(
  writer: AuditWriter,
  input: RecordAuditInput,
): Promise<AuditRecord> {
  const row = await writer.auditLog.create({
    data: {
      companyId: input.companyId,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before ?? undefined,
      after: input.after ?? undefined,
      ip: input.ip ?? null,
    },
    select: {
      id: true,
      companyId: true,
      actorId: true,
      action: true,
      entityType: true,
      entityId: true,
      before: true,
      after: true,
      ip: true,
      createdAt: true,
    },
  });
  return row as AuditRecord;
}

/** Filtro opcional de leitura da trilha (sempre escopado por tenant). */
export interface ListAuditFilter {
  entityType?: string;
  entityId?: string;
}

/**
 * Lê registros de auditoria de um tenant (append-only ⇒ somente leitura).
 * Escopado por `companyId` (nunca cruza tenants). Ordena por `createdAt` asc.
 */
export async function listAudit(
  reader: AuditReader,
  companyId: string,
  filter: ListAuditFilter = {},
): Promise<AuditRecord[]> {
  const rows = await reader.auditLog.findMany({
    where: {
      companyId,
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      companyId: true,
      actorId: true,
      action: true,
      entityType: true,
      entityId: true,
      before: true,
      after: true,
      ip: true,
      createdAt: true,
    },
  });
  return rows as AuditRecord[];
}

/**
 * Guarda explícita de imutabilidade: SEMPRE lança {@link AuditImmutabilityError}.
 *
 * O serviço não oferece update/delete de `AuditLog`; esta função existe para
 * que qualquer caminho que tente mutar a trilha via serviço falhe de forma
 * clara e testável, reforçando a intenção append-only da camada de aplicação.
 * A proteção AUTORITATIVA continua sendo a de banco (ver cabeçalho + NOTA).
 */
export function rejectAuditMutation(operation: "update" | "delete"): never {
  throw new AuditImmutabilityError(operation);
}

/**
 * Superfície pública do AuditService: APPEND + READ + guarda de imutabilidade.
 * NÃO expõe update/delete — a mutação da trilha é, por construção, indisponível.
 */
export const AuditService = {
  recordAudit,
  listAudit,
  rejectAuditMutation,
} as const;

/**
 * Executa `op` (a operação sensível) e, no SUCESSO, grava EXATAMENTE UM
 * `AuditLog` com o `before`/`after` fornecidos — dentro da MESMA transação, de
 * modo que a operação e seu registro de auditoria sejam atômicos (Property 10:
 * toda operação sensível bem-sucedida gera exatamente um AuditLog consistente).
 *
 * Se `op` LANÇAR, a transação é revertida e NENHUM `AuditLog` é gravado (não há
 * auditoria de operação que não teve sucesso). Se `op` tiver sucesso, há
 * exatamente um append de auditoria — nunca zero, nunca dois.
 *
 * `buildEntry` recebe o resultado de `op` e produz a entrada de auditoria
 * (permitindo derivar `entityId`/`after` do resultado real da operação).
 *
 * @param client cliente Prisma com `$transaction` (injetável para testes).
 * @param op operação sensível a executar dentro da transação.
 * @param buildEntry constrói a entrada de auditoria a partir do resultado.
 */
export async function withAudit<T>(
  client: Pick<PrismaClient, "$transaction">,
  op: (tx: Prisma.TransactionClient) => Promise<T>,
  buildEntry: (result: T) => RecordAuditInput,
): Promise<{ result: T; audit: AuditRecord }> {
  return client.$transaction(async (tx) => {
    const result = await op(tx);
    const audit = await recordAudit(
      tx as unknown as AuditWriter,
      buildEntry(result),
    );
    return { result, audit };
  });
}

/** Cliente default (produção) — açúcar para chamadores fora de teste. */
export function defaultAuditClient(): AuditWriter & AuditReader {
  return defaultPrisma as unknown as AuditWriter & AuditReader;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * NOTA DE MIGRAÇÃO — enforcement de imutabilidade no BANCO (produção).
 *
 * A imutabilidade AUTORITATIVA de `AuditLog` NÃO pode ser garantida pelo client
 * Prisma; deve ser imposta no PostgreSQL. Criar uma migração SQL dedicada com,
 * por exemplo, um trigger append-only:
 *
 *   -- prisma/migrations/<ts>_auditlog_immutable/migration.sql
 *   CREATE OR REPLACE FUNCTION auditlog_no_mutation()
 *   RETURNS trigger LANGUAGE plpgsql AS $$
 *   BEGIN
 *     RAISE EXCEPTION 'AuditLog is append-only (% not allowed)', TG_OP;
 *   END; $$;
 *
 *   CREATE TRIGGER auditlog_immutable
 *     BEFORE UPDATE OR DELETE ON "AuditLog"
 *     FOR EACH ROW EXECUTE FUNCTION auditlog_no_mutation();
 *
 * Alternativa/complemento: revogar grants ao papel da aplicação —
 *   REVOKE UPDATE, DELETE ON "AuditLog" FROM <app_role>;
 *
 * A guarda no cliente (superfície append+read + rejectAuditMutation) é a
 * primeira linha de defesa e documenta a intenção; o trigger/grant é o que
 * garante a imutabilidade contra acesso direto ao banco.
 * ───────────────────────────────────────────────────────────────────────────*/
