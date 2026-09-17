import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Priority, TicketStatus } from "@prisma/client";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { slaStatus } from "@/lib/sla";

const statusColors: Record<TicketStatus, string> = {
  OPEN: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-yellow-100 text-yellow-700",
  WAITING: "bg-purple-100 text-purple-700",
  PENDING_APPROVAL: "bg-amber-100 text-amber-700",
  RESOLVED: "bg-green-100 text-green-700",
  CLOSED: "bg-gray-100 text-gray-600",
};

const statusLabels: Record<TicketStatus, string> = {
  OPEN: "Aberto",
  IN_PROGRESS: "Em andamento",
  WAITING: "Aguardando",
  PENDING_APPROVAL: "Aguardando aprovação",
  RESOLVED: "Resolvido",
  CLOSED: "Fechado",
};

const priorityColors: Record<Priority, string> = {
  LOW: "text-gray-500",
  MEDIUM: "text-blue-500",
  HIGH: "text-orange-500",
  CRITICAL: "text-red-600 font-semibold",
};

const priorityLabels: Record<Priority, string> = {
  LOW: "Baixa",
  MEDIUM: "Média",
  HIGH: "Alta",
  CRITICAL: "Crítica",
};

const PAGE_SIZE = 25;

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: { status?: string; priority?: string; page?: string };
}) {
  const session = await auth();
  const companyId = session!.user.companyId;
  const isClient = session!.user.role === "CLIENT";
  const isSuperAdmin = session!.user.role === "SUPERADMIN";

  const where: any = isSuperAdmin ? {} : { companyId };
  if (isClient) where.createdById = session!.user.id;
  if (searchParams.status) where.status = searchParams.status;
  if (searchParams.priority) where.priority = searchParams.priority;

  const page = Math.max(1, Number(searchParams.page ?? "1") || 1);

  const [tickets, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      include: {
        createdBy: { select: { name: true } },
        assignedTo: { select: { name: true } },
        company: { select: { name: true } },
        _count: { select: { comments: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.ticket.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const buildPageHref = (p: number) => {
    const qs = new URLSearchParams();
    if (searchParams.status) qs.set("status", searchParams.status);
    if (searchParams.priority) qs.set("priority", searchParams.priority);
    qs.set("page", String(p));
    return `/tickets?${qs.toString()}`;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Tickets</h1>
        <Link href="/tickets/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
          + Novo ticket
        </Link>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Título</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Prioridade</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">SLA</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Aberto</th>
              {!isClient && <th className="text-left px-4 py-3 font-medium text-gray-600">Solicitante</th>}
              {isSuperAdmin && <th className="text-left px-4 py-3 font-medium text-gray-600">Empresa</th>}
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => {
              const sla = slaStatus(t.slaDeadline);
              return (
                <tr key={t.id} className="border-b last:border-0 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/tickets/${t.id}`} className="font-medium hover:text-blue-600">
                      {t.title}
                    </Link>
                    {t._count.comments > 0 && (
                      <span className="ml-2 text-xs text-gray-400">{t._count.comments} comentários</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-1 rounded-full ${statusColors[t.status]}`}>{statusLabels[t.status]}</span>
                  </td>
                  <td className={`px-4 py-3 text-xs ${priorityColors[t.priority]}`}>{priorityLabels[t.priority]}</td>
                  <td className="px-4 py-3">
                    {sla === "breached" && <span className="text-xs text-red-600 font-medium">Violado</span>}
                    {sla === "warning" && <span className="text-xs text-orange-500">Expirando</span>}
                    {sla === "ok" && <span className="text-xs text-green-600">OK</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{formatDistanceToNow(t.createdAt, { locale: ptBR, addSuffix: true })}</td>
                  {!isClient && <td className="px-4 py-3 text-gray-500">{t.createdBy.name}</td>}
                  {isSuperAdmin && <td className="px-4 py-3"><span className="text-xs bg-purple-50 text-purple-700 px-2 py-1 rounded-full">{(t as any).company?.name}</span></td>}
                </tr>
              );
            })}
            {tickets.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Nenhum ticket encontrado</td></tr>
            )}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t text-sm text-gray-500">
            <span>
              Página {page} de {totalPages} • {total} ticket{total !== 1 ? "s" : ""}
            </span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link href={buildPageHref(page - 1)} className="px-3 py-1.5 rounded-lg border hover:bg-gray-50">
                  Anterior
                </Link>
              )}
              {page < totalPages && (
                <Link href={buildPageHref(page + 1)} className="px-3 py-1.5 rounded-lg border hover:bg-gray-50">
                  Próxima
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
