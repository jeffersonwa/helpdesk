/**
 * Route handler `/api/health` (tarefa 30.2).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Observabilidade") e requirements 19.3, 19.4.
 *
 * Este handler é a BORDA: monta os probes reais (Prisma) e delega o cálculo à
 * função pura `computeHealth`. A rota responde em ≤2s (cada probe tem timeout) e
 * traduz o estado geral em HTTP 200 (healthy/degraded) ou 503 (unhealthy).
 *
 * Probes:
 *  - `db`    → `SELECT 1` via `$queryRaw` (conectividade do banco).
 *  - `queue` → conta eventos do outbox em backlog (`OutboxEvent`), confirmando
 *              que a fila é acessível. Não falha por backlog alto; falha só se a
 *              consulta não completar (indisponibilidade).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  computeHealth,
  healthHttpStatus,
  type Probe,
} from "@/lib/observability/health";

/** Evita cache: o health precisa refletir o estado em tempo real. */
export const dynamic = "force-dynamic";

/** Probe do banco: `SELECT 1`. Lança em falha (tratado como unhealthy). */
const dbProbe: Probe = async () => {
  await prisma.$queryRaw`SELECT 1`;
};

/** Probe da fila: consulta acessibilidade do outbox (count leve). */
const queueProbe: Probe = async () => {
  await prisma.outboxEvent.count({ where: { state: "PENDING" } });
};

/** GET `/api/health`: reporta o estado por dependência (Req. 19.3, 19.4). */
export async function GET(): Promise<NextResponse> {
  const report = await computeHealth({ dbProbe, queueProbe });
  return NextResponse.json(report, { status: healthHttpStatus(report.status) });
}
