/**
 * ReportsService — cálculo de KPIs e métricas de atendimento (backend).
 *
 * Tarefa 27.1. Fonte autoritativa:
 * `.kiro/specs/helpdesk-omnichannel/design.md` (seção "Relatórios e KPIs") e
 * requirement 15.
 *
 * Métricas produzidas (Req. 15.1–15.4):
 *  - `countByStatus`: contagem de tickets por `TicketStatus`.
 *  - `countByQueue`: contagem de tickets por fila (`queueId`).
 *  - `firstResponseMinutes`: tempo médio, em minutos, entre a abertura do
 *    ticket (`createdAt`) e a primeira resposta de um atendente
 *    (`firstResponseAt`), sobre os tickets do período que já tiveram resposta
 *    (Req. 15.2).
 *  - `slaViolationRate`: percentual (0–100, 2 casas decimais) de tickets cujo
 *    tempo de resposta OU de resolução excedeu o prazo de SLA, sobre o total de
 *    tickets do período (Req. 15.3).
 *  - `throughputByChannel`: contagem de mensagens trocadas por canal no período
 *    (Req. 15.4). O canal é derivado do tipo da `ChannelAccount` da conversa.
 *
 * Escopo (Req. 15.5, 15.6): TODAS as consultas são restritas ao `companyId`
 * (derivado do servidor pelo chamador) E, quando o usuário tem escopo restrito,
 * limitadas aos recursos cobertos por esse escopo. O escopo restrito é
 * traduzido em filtros adicionais (fila/time/etc.) aplicados ao `where`.
 *
 * Período vazio (Req. 15.8): quando não há dados no período/filtro, cada
 * métrica é apresentada com valor ZERO (contagens vazias, tempo 0, taxa 0.00).
 *
 * Decisão da fórmula de taxa de violação de SLA:
 *  - violado := (firstResponseAt existe E > slaResponseDeadline) OU
 *               (resolvedAt existe E > slaResolutionDeadline).
 *  - taxa := total === 0 ? 0 : round2(100 * violados / total). "round2" arredonda
 *    para 2 casas decimais (half-up), garantindo o intervalo [0, 100].
 *
 * _Requisitos: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8_
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { ChannelType, TicketStatus } from "@/lib/domain/enums";

/**
 * Filtro de escopo restrito do usuário (Req. 15.6). Quando presente, cada
 * campo limita as consultas aos recursos cobertos. Campos ausentes não
 * restringem. Derivado dos escopos RBAC do usuário pela camada chamadora.
 */
export interface ReportScope {
  queueIds?: string[];
  teamIds?: string[];
  unitIds?: string[];
  departmentIds?: string[];
  categoryIds?: string[];
  /** Restringe a tickets atribuídos a estes agentes (ex.: escopo próprio). */
  assignedToIds?: string[];
}

/** Janela temporal do relatório (inclusiva em `from`, exclusiva em `to`). */
export interface ReportPeriod {
  from: Date;
  to: Date;
}

/** Parâmetros de uma consulta de métricas. */
export interface ReportQuery {
  companyId: string;
  period: ReportPeriod;
  scope?: ReportScope;
}

/** Conjunto completo de métricas retornado por `computeMetrics`. */
export interface ReportMetrics {
  /** Contagem de tickets por status (todos os status presentes, mesmo 0). */
  countByStatus: Record<string, number>;
  /** Contagem de tickets por fila (`queueId`). `null` → sem fila. */
  countByQueue: Record<string, number>;
  /** Tempo médio de primeira resposta em minutos (0 se não houver amostras). */
  firstResponseMinutes: number;
  /** Taxa de violação de SLA em % (0–100, 2 casas decimais). */
  slaViolationRate: number;
  /** Contagem de mensagens por canal (`ChannelType`). */
  throughputByChannel: Record<string, number>;
  /** Total de tickets no período/escopo (base da taxa de SLA). */
  totalTickets: number;
}

/**
 * Cliente Prisma mínimo consumido pelo serviço. Injetável nos testes.
 * `ticket.groupBy`/`count`, `ticket.findMany` (para primeira resposta e SLA) e
 * `message.count` (throughput por canal filtrado por relação).
 */
export type ReportsClient = {
  ticket: {
    groupBy: PrismaClient["ticket"]["groupBy"];
    count: PrismaClient["ticket"]["count"];
    findMany: PrismaClient["ticket"]["findMany"];
  };
  message: {
    count: PrismaClient["message"]["count"];
  };
};

/** Cliente default (produção). */
export function defaultReportsClient(): ReportsClient {
  return defaultPrisma as unknown as ReportsClient;
}

/** Arredonda para 2 casas decimais (half-up), evitando ruído de ponto flutuante. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Constrói a cláusula `where` base de tickets: sempre por `companyId`, dentro do
 * período (`createdAt`) e restrita pelo escopo do usuário quando informado.
 * Este é o núcleo que garante isolamento de tenant + cobertura de escopo
 * (Req. 15.5, 15.6).
 */
function ticketWhere(query: ReportQuery): Record<string, unknown> {
  const { companyId, period, scope } = query;
  const where: Record<string, unknown> = {
    companyId,
    createdAt: { gte: period.from, lt: period.to },
  };
  if (scope?.queueIds) where.queueId = { in: scope.queueIds };
  if (scope?.teamIds) where.teamId = { in: scope.teamIds };
  if (scope?.unitIds) where.unitId = { in: scope.unitIds };
  if (scope?.departmentIds) where.departmentId = { in: scope.departmentIds };
  if (scope?.categoryIds) where.categoryId = { in: scope.categoryIds };
  if (scope?.assignedToIds) where.assignedToId = { in: scope.assignedToIds };
  return where;
}

/** Zera contagens por status (todos os status do enum presentes). */
function zeroedStatusCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of Object.values(TicketStatus)) out[s] = 0;
  return out;
}

/** Zera contagens por canal (todos os canais do enum presentes). */
function zeroedChannelCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of Object.values(ChannelType)) out[c] = 0;
  return out;
}

/**
 * Contagem de tickets por status via `groupBy` (Req. 15.1). Começa com todos os
 * status zerados (período vazio → zeros, Req. 15.8) e sobrepõe as contagens
 * observadas.
 */
export async function countByStatus(
  client: ReportsClient,
  query: ReportQuery,
): Promise<Record<string, number>> {
  const rows = (await client.ticket.groupBy({
    by: ["status"],
    where: ticketWhere(query),
    _count: { _all: true },
  })) as unknown as Array<{ status: string; _count: { _all: number } }>;

  const out = zeroedStatusCounts();
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}

/**
 * Contagem de tickets por fila via `groupBy` (Req. 15.1). Tickets sem fila
 * (`queueId === null`) são agregados sob a chave `"__none__"`.
 */
export async function countByQueue(
  client: ReportsClient,
  query: ReportQuery,
): Promise<Record<string, number>> {
  const rows = (await client.ticket.groupBy({
    by: ["queueId"],
    where: ticketWhere(query),
    _count: { _all: true },
  })) as unknown as Array<{
    queueId: string | null;
    _count: { _all: number };
  }>;

  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.queueId ?? "__none__"] = r._count._all;
  }
  return out;
}

/**
 * Tempo médio de primeira resposta em minutos (Req. 15.2).
 *
 * Considera apenas tickets do período que já têm `firstResponseAt`. Para cada
 * um, calcula `(firstResponseAt - createdAt)` em minutos e devolve a média
 * arredondada a 2 casas. Sem amostras → 0 (Req. 15.8).
 */
export async function firstResponseMinutes(
  client: ReportsClient,
  query: ReportQuery,
): Promise<number> {
  const rows = (await client.ticket.findMany({
    where: { ...ticketWhere(query), firstResponseAt: { not: null } },
    select: { createdAt: true, firstResponseAt: true },
  })) as unknown as Array<{ createdAt: Date; firstResponseAt: Date | null }>;

  if (rows.length === 0) return 0;

  let totalMinutes = 0;
  for (const r of rows) {
    if (!r.firstResponseAt) continue;
    const diffMs = r.firstResponseAt.getTime() - r.createdAt.getTime();
    totalMinutes += diffMs / 60_000;
  }
  return round2(totalMinutes / rows.length);
}

/**
 * Taxa de violação de SLA em % (0–100, 2 casas decimais) — Req. 15.3.
 *
 * Um ticket é "violado" se a primeira resposta ocorreu após o
 * `slaResponseDeadline` OU a resolução ocorreu após o `slaResolutionDeadline`.
 * Denominador = total de tickets do período/escopo. Total 0 → 0.00 (Req. 15.8).
 */
export async function slaViolationRate(
  client: ReportsClient,
  query: ReportQuery,
): Promise<number> {
  const where = ticketWhere(query);

  const total = await client.ticket.count({ where });
  if (total === 0) return 0;

  const rows = (await client.ticket.findMany({
    where,
    select: {
      firstResponseAt: true,
      slaResponseDeadline: true,
      resolvedAt: true,
      slaResolutionDeadline: true,
    },
  })) as unknown as Array<{
    firstResponseAt: Date | null;
    slaResponseDeadline: Date | null;
    resolvedAt: Date | null;
    slaResolutionDeadline: Date | null;
  }>;

  let violated = 0;
  for (const r of rows) {
    const responseViolated =
      r.firstResponseAt !== null &&
      r.slaResponseDeadline !== null &&
      r.firstResponseAt.getTime() > r.slaResponseDeadline.getTime();
    const resolutionViolated =
      r.resolvedAt !== null &&
      r.slaResolutionDeadline !== null &&
      r.resolvedAt.getTime() > r.slaResolutionDeadline.getTime();
    if (responseViolated || resolutionViolated) violated += 1;
  }

  return round2((100 * violated) / total);
}

/**
 * Throughput de mensagens por canal no período (Req. 15.4).
 *
 * `Message` não carrega o canal diretamente; ele é o tipo da `ChannelAccount`
 * da conversa. Para manter a forma de consulta razoável e mockável, contamos as
 * mensagens por `ChannelType` filtrando pela relação
 * `conversation.channelAccount.type`. Escopo de tenant é aplicado via
 * `Message.companyId`. Canais sem mensagens permanecem em 0 (Req. 15.8).
 */
export async function throughputByChannel(
  client: ReportsClient,
  query: ReportQuery,
): Promise<Record<string, number>> {
  const out = zeroedChannelCounts();
  const channels = Object.values(ChannelType);

  const counts = await Promise.all(
    channels.map((channel) =>
      client.message.count({
        where: {
          companyId: query.companyId,
          createdAt: { gte: query.period.from, lt: query.period.to },
          conversation: { channelAccount: { type: channel } },
        },
      }),
    ),
  );

  channels.forEach((channel, i) => {
    out[channel] = counts[i];
  });
  return out;
}

/**
 * Calcula TODAS as métricas de uma vez (Req. 15.1). Conveniência que compõe as
 * funções acima com o mesmo `query` (mesmo tenant, período e escopo).
 */
export async function computeMetrics(
  client: ReportsClient,
  query: ReportQuery,
): Promise<ReportMetrics> {
  const where = ticketWhere(query);
  const [byStatus, byQueue, frMinutes, slaRate, throughput, total] =
    await Promise.all([
      countByStatus(client, query),
      countByQueue(client, query),
      firstResponseMinutes(client, query),
      slaViolationRate(client, query),
      throughputByChannel(client, query),
      client.ticket.count({ where }),
    ]);

  return {
    countByStatus: byStatus,
    countByQueue: byQueue,
    firstResponseMinutes: frMinutes,
    slaViolationRate: slaRate,
    throughputByChannel: throughput,
    totalTickets: total,
  };
}

/** Superfície pública do ReportsService. */
export const ReportsService = {
  countByStatus,
  countByQueue,
  firstResponseMinutes,
  slaViolationRate,
  throughputByChannel,
  computeMetrics,
} as const;
