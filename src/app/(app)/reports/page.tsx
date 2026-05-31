import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Priority, TicketStatus } from "@prisma/client";

const statusLabels: Record<TicketStatus, string> = {
  OPEN: "Aberto",
  IN_PROGRESS: "Em andamento",
  WAITING: "Aguardando",
  RESOLVED: "Resolvido",
  CLOSED: "Fechado",
};

const priorityLabels: Record<Priority, string> = {
  LOW: "Baixa",
  MEDIUM: "Média",
  HIGH: "Alta",
  CRITICAL: "Crítica",
};

export default async function ReportsPage() {
  const session = await auth();
  if (!["ADMIN", "SUPERADMIN", "AGENT"].includes(session!.user.role)) redirect("/dashboard");

  const companyId = session!.user.companyId;
  const now = new Date();

  const [total, byStatus, byPriority, slaBreached] = await Promise.all([
    prisma.ticket.count({ where: { companyId } }),
    prisma.ticket.groupBy({ by: ["status"], where: { companyId }, _count: { status: true } }),
    prisma.ticket.groupBy({ by: ["priority"], where: { companyId }, _count: { priority: true } }),
    prisma.ticket.count({ where: { companyId, slaDeadline: { lt: now }, status: { notIn: ["RESOLVED", "CLOSED"] } } }),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Relatórios</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <div className="text-3xl font-bold text-blue-600">{total}</div>
          <div className="text-sm text-gray-500 mt-1">Total de tickets</div>
        </div>
        <div className="bg-red-50 rounded-2xl border border-red-100 p-5">
          <div className="text-3xl font-bold text-red-600">{slaBreached}</div>
          <div className="text-sm text-red-500 mt-1">SLA violado</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold mb-4">Por status</h2>
          <div className="space-y-3">
            {byStatus.map((s) => (
              <div key={s.status} className="flex items-center justify-between">
                <span className="text-sm text-gray-600">{statusLabels[s.status]}</span>
                <div className="flex items-center gap-3">
                  <div className="w-32 bg-gray-100 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full"
                      style={{ width: `${total > 0 ? (s._count.status / total) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium w-6 text-right">{s._count.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold mb-4">Por prioridade</h2>
          <div className="space-y-3">
            {byPriority.map((p) => (
              <div key={p.priority} className="flex items-center justify-between">
                <span className="text-sm text-gray-600">{priorityLabels[p.priority]}</span>
                <div className="flex items-center gap-3">
                  <div className="w-32 bg-gray-100 rounded-full h-2">
                    <div
                      className="bg-orange-400 h-2 rounded-full"
                      style={{ width: `${total > 0 ? (p._count.priority / total) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium w-6 text-right">{p._count.priority}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
