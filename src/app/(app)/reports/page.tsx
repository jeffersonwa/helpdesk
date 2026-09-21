import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import type { ReportMetrics } from "@/lib/reports/service";
import { loadReport, normalizePeriodKey } from "./data";
import PeriodSelector from "./PeriodSelector";

/** Rótulos em pt-BR para status de ticket (chaves do enum). */
const statusLabels: Record<string, string> = {
  OPEN: "Aberto",
  IN_PROGRESS: "Em andamento",
  WAITING: "Aguardando",
  PENDING_APPROVAL: "Aguardando aprovação",
  RESOLVED: "Resolvido",
  CLOSED: "Fechado",
  CANCELLED: "Cancelado",
};

/** Rótulos em pt-BR para canais (chaves do enum ChannelType). */
const channelLabels: Record<string, string> = {
  WEB: "Web",
  WHATSAPP: "WhatsApp",
  EMAIL: "E-mail",
  PUBLIC_FORM: "Formulário público",
  API: "API",
};

/**
 * Relatórios e dashboards do console (tarefa 35.1).
 *
 * Server Component que consome o `ReportsService` via `loadReport`, o qual
 * materializa o usuário da sessão, deriva o escopo RBAC (Req. 15.6) e restringe
 * por `companyId` (Req. 15.5). O período vem do `searchParams` (seletor
 * client). Ausência de dados → métricas zeradas (Req. 15.8); falha no cálculo →
 * estado de erro preservando a visualização (Req. 15.7).
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await auth();
  if (!["ADMIN", "SUPERADMIN", "AGENT"].includes(session!.user.role)) redirect("/dashboard");

  const { period } = await searchParams;
  const load = await loadReport(period);
  const periodKey = load.ok ? load.periodKey : normalizePeriodKey(period);

  // Nomes de fila do tenant para rotular as contagens por fila (isolamento por
  // companyId da sessão).
  const queues = await prisma.queue.findMany({
    where: { companyId: session!.user.companyId },
    select: { id: true, name: true },
  });
  const queueName = new Map(queues.map((q) => [q.id, q.name]));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Relatórios</h1>
        <PeriodSelector current={periodKey} />
      </div>

      {!load.ok ? (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-6 flex items-start gap-3">
          <AlertTriangle className="text-red-500 mt-0.5" size={20} />
          <div>
            <p className="font-medium text-red-700">Falha ao gerar o relatório</p>
            <p className="text-sm text-red-500 mt-1">{load.error}</p>
          </div>
        </div>
      ) : (
        <ReportContent metrics={load.metrics} queueName={queueName} />
      )}
    </div>
  );
}

/** Renderiza os cartões de KPI a partir das métricas calculadas. */
function ReportContent({
  metrics,
  queueName,
}: {
  metrics: ReportMetrics;
  queueName: Map<string, string>;
}) {
  const total = metrics.totalTickets;
  const statusEntries = Object.entries(metrics.countByStatus).filter(([, n]) => n > 0);
  const queueEntries = Object.entries(metrics.countByQueue);
  const channelEntries = Object.entries(metrics.throughputByChannel);

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <div className="text-3xl font-bold text-blue-600">{total}</div>
          <div className="text-sm text-gray-500 mt-1">Total de tickets</div>
        </div>
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <div className="text-3xl font-bold text-gray-800">{metrics.firstResponseMinutes}</div>
          <div className="text-sm text-gray-500 mt-1">1ª resposta (min)</div>
        </div>
        <div className="bg-red-50 rounded-2xl border border-red-100 p-5">
          <div className="text-3xl font-bold text-red-600">
            {metrics.slaViolationRate.toFixed(2)}%
          </div>
          <div className="text-sm text-red-500 mt-1">Violação de SLA</div>
        </div>
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <div className="text-3xl font-bold text-gray-800">
            {channelEntries.reduce((sum, [, n]) => sum + n, 0)}
          </div>
          <div className="text-sm text-gray-500 mt-1">Mensagens no período</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold mb-4">Tickets por status</h2>
          {statusEntries.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">Sem dados no período.</p>
          ) : (
            <div className="space-y-3">
              {statusEntries.map(([status, count]) => (
                <div key={status} className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">{statusLabels[status] ?? status}</span>
                  <div className="flex items-center gap-3">
                    <div className="w-32 bg-gray-100 rounded-full h-2">
                      <div
                        className="bg-blue-500 h-2 rounded-full"
                        style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium w-8 text-right">{count}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold mb-4">Tickets por fila</h2>
          {queueEntries.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">Sem dados no período.</p>
          ) : (
            <div className="space-y-3">
              {queueEntries.map(([queueId, count]) => (
                <div key={queueId} className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">
                    {queueId === "__none__" ? "Sem fila" : queueName.get(queueId) ?? queueId}
                  </span>
                  <div className="flex items-center gap-3">
                    <div className="w-32 bg-gray-100 rounded-full h-2">
                      <div
                        className="bg-orange-400 h-2 rounded-full"
                        style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium w-8 text-right">{count}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border p-6 lg:col-span-2">
          <h2 className="font-semibold mb-4">Throughput por canal</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {channelEntries.map(([channel, count]) => (
              <div key={channel} className="rounded-xl bg-gray-50 p-4">
                <div className="text-2xl font-bold text-gray-800">{count}</div>
                <div className="text-xs text-gray-500 mt-1">{channelLabels[channel] ?? channel}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
