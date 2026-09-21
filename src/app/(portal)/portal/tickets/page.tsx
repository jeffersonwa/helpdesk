import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { TicketStatus } from "@prisma/client";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Plus } from "lucide-react";

const statusColors: Record<TicketStatus, string> = {
  OPEN: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-yellow-100 text-yellow-700",
  WAITING: "bg-purple-100 text-purple-700",
  PENDING_APPROVAL: "bg-amber-100 text-amber-700",
  RESOLVED: "bg-green-100 text-green-700",
  CLOSED: "bg-gray-100 text-gray-600",
  CANCELLED: "bg-gray-100 text-gray-600",
};

const statusLabels: Record<TicketStatus, string> = {
  OPEN: "Aberto",
  IN_PROGRESS: "Em andamento",
  WAITING: "Aguardando",
  PENDING_APPROVAL: "Aguardando aprovação",
  RESOLVED: "Resolvido",
  CLOSED: "Fechado",
  CANCELLED: "Cancelado",
};

/**
 * Lista de chamados do solicitante no portal (tarefa 34.1).
 *
 * Server Component: exibe SOMENTE os chamados do próprio solicitante
 * (`createdById` da sessão) dentro do seu tenant (`companyId` da sessão) —
 * Req. 14.1, 14.4. Um chamado de outro solicitante/tenant nunca aparece aqui.
 */
export default async function PortalTicketsPage() {
  const session = await auth();
  const companyId = session!.user.companyId;
  const userId = session!.user.id;

  const tickets = await prisma.ticket.findMany({
    where: { companyId, createdById: userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
      _count: { select: { comments: true } },
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Meus chamados</h1>
        <Link
          href="/tickets/new"
          className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          <Plus size={18} /> Novo chamado
        </Link>
      </div>

      <div className="bg-white rounded-2xl border shadow-sm divide-y">
        {tickets.map((t) => (
          <Link
            key={t.id}
            href={`/tickets/${t.id}`}
            className="flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors first:rounded-t-2xl last:rounded-b-2xl"
          >
            <div>
              <p className="font-medium text-sm">{t.title}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {formatDistanceToNow(t.createdAt, { locale: ptBR, addSuffix: true })}
                {t._count.comments > 0 && ` • ${t._count.comments} comentário${t._count.comments !== 1 ? "s" : ""}`}
              </p>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColors[t.status]}`}>
              {statusLabels[t.status]}
            </span>
          </Link>
        ))}
        {tickets.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-gray-400">
            Você ainda não abriu nenhum chamado.{" "}
            <Link href="/tickets/new" className="text-blue-600 hover:underline">
              Abrir o primeiro
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}
