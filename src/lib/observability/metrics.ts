/**
 * Métricas de observabilidade — snapshot exportável (tarefa 30.2).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Observabilidade") e requirement 19.5.
 *
 * ------------------------------------------------------------------------
 * DECISÃO DE PROJETO (documentada, conforme pedido)
 * ------------------------------------------------------------------------
 * O design lista, como métricas: tickets por status/fila, tempo de primeira
 * resposta, taxa de violação de SLA, throughput por canal e falhas de outbox.
 * As QUATRO primeiras JÁ são calculadas pelo `ReportsService` (tarefa 27.1),
 * derivando-as diretamente do estado persistido (fonte da verdade). A opção
 * mais simples E correta é REUTILIZAR o `ReportsService` via prisma injetado,
 * em vez de manter um registry de contadores em memória — este último exigiria
 * instrumentar cada caminho de código, correria risco de divergir do estado
 * real e se perderia a cada reinício/entre instâncias.
 *
 * A ÚNICA métrica não coberta pelo `ReportsService` é "falhas de outbox", que
 * obtemos com um `count` de `OutboxEvent` no estado `FAILED` (por tenant).
 *
 * Resultado: `snapshotMetrics(deps, query)` compõe `ReportsService.computeMetrics`
 * + a contagem de falhas de outbox num único objeto serializável, com o mesmo
 * escopo de tenant/período. Tudo é injetável ⇒ testável sem banco real.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { OutboxState } from "@/lib/domain/enums";
import {
  ReportsService,
  type ReportsClient,
  type ReportQuery,
  type ReportMetrics,
} from "@/lib/reports/service";

/** Prisma mínimo para a contagem de falhas de outbox (por tenant). */
export type OutboxMetricsClient = {
  outboxEvent: {
    count: PrismaClient["outboxEvent"]["count"];
  };
};

/** Dependências injetáveis de {@link snapshotMetrics}. */
export interface MetricsDeps {
  /** Client do ReportsService (tickets/mensagens). */
  reports: ReportsClient;
  /** Client para contar falhas de outbox. */
  outbox: OutboxMetricsClient;
}

/** Snapshot completo de métricas (Req. 19.5). */
export interface MetricsSnapshot extends ReportMetrics {
  /** Nº de `OutboxEvent` em estado `FAILED` no tenant (falhas de entrega). */
  outboxFailures: number;
}

/**
 * Conta os eventos de outbox em `FAILED` para o tenant do `query`. As falhas de
 * outbox refletem entregas externas (webhooks, envios) esgotadas após 5
 * tentativas — sinal operacional relevante (Req. 17.6, 19.5).
 */
export async function outboxFailureCount(
  client: OutboxMetricsClient,
  query: Pick<ReportQuery, "companyId">,
): Promise<number> {
  return client.outboxEvent.count({
    where: { companyId: query.companyId, state: OutboxState.FAILED },
  });
}

/**
 * Produz o snapshot de métricas do tenant/período: reutiliza
 * `ReportsService.computeMetrics` (tickets por status/fila, primeira resposta,
 * taxa de violação de SLA, throughput por canal) e adiciona `outboxFailures`.
 */
export async function snapshotMetrics(
  deps: MetricsDeps,
  query: ReportQuery,
): Promise<MetricsSnapshot> {
  const [metrics, outboxFailures] = await Promise.all([
    ReportsService.computeMetrics(deps.reports, query),
    outboxFailureCount(deps.outbox, query),
  ]);

  return { ...metrics, outboxFailures };
}

/** Deps default (produção): o mesmo `prisma` compartilhado para ambos. */
export function defaultMetricsDeps(): MetricsDeps {
  return {
    reports: defaultPrisma as unknown as ReportsClient,
    outbox: defaultPrisma as unknown as OutboxMetricsClient,
  };
}
