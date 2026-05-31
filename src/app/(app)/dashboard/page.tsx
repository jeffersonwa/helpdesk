import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { TicketStatus } from "@prisma/client";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

const statusColors: Record<TicketStatus, string> = {
  OPEN: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-yellow-100 text-yellow-700",
  WAITING: "bg-purple-100 text-purple-700",
  RESOLVED: "bg-green-100 text-green-700",
  CLOSED: "bg-gray-100 text-gray-600",
};

const statusLabels: Record<TicketStatus, string> = {
  OPEN: "Aberto",
  IN_PROGRESS: "Em andamento",
  WAITING: "Aguardando",
  RESOLVED: "Resolvido",
  CLOSED: "Fechado",
};

export default async function DashboardPage() {
  const session = await auth();
  const companyId = session!.user.companyId;
  const isClient = session!.user.role === "CLIENT";

  const where: any = { companyId };
  if (isClient) where.createdById = session!.user.id;

  const [total, open, inProgress, slaBreached, recent] = await Promise.all([
    prisma.ticket.count({ where }),
    prisma.ticket.count({ where: { ...where, status: "OPEN" } }),
    prisma.ticket.count({ where: { ...where, status: "IN_PROGRESS" } }),
    prisma.ticket.count({ where: { ...where, slaDeadline: { lt: new Date() }, status: { notIn: ["RESOLVED", "CLOSED"] } } }),
    prisma.ticket.findMany({ where, orderBy: { createdAt: "desc" }, take: 5, include: { createdBy: { select: { name: true } } } }),
  ]);

  const stats = [
    { label: "Total", value: total, color: "bg-blue-50 text-blue-700" },
    { label: "Abertos", value: open, color: "bg-yellow-50 text-yellow-700" },
    { label: "Em andamento", value: inProgress, color: "bg-purple-50 text-purple-700" },
    { label: "SLA violado", value: slaBreached, color: "bg-red-50 text-red-700" },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link href="/tickets/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
          + Novo ticket
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map((s) => (
          <div key={s.label} className={`rounded-2xl p-5 ${s.color}`}>
            <div className="text-3xl font-bold">{s.value}</div>
            <div className="text-sm mt-1 opacity-80">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <h2 className="font-semibold mb-4">Tickets recentes</h2>
        <div className="space-y-3">
          {recent.map((t) => (
            <Link key={t.id} href={`/tickets/${t.id}`} className="flex items-center justify-between py-3 border-b last:border-0 hover:bg-gray-50 -mx-2 px-2 rounded-lg transition-colors">
              <div>
                <p className="font-medium text-sm">{t.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">por {t.createdBy.name} • {formatDistanceToNow(t.createdAt, { locale: ptBR, addSuffix: true })}</p>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColors[t.status]}`}>{statusLabels[t.status]}</span>
            </Link>
          ))}
          {recent.length === 0 && <p className="text-sm text-gray-400 text-center py-4">Nenhum ticket ainda</p>}
        </div>
      </div>
    </div>
  );
}
