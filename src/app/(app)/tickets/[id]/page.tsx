import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { Priority, TicketStatus } from "@prisma/client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { slaStatus } from "@/lib/sla";
import TicketActions from "./TicketActions";
import CommentForm from "./CommentForm";

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

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const { id } = await params;
  const ticket = await prisma.ticket.findFirst({
    where: { id, companyId: session!.user.companyId },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      assignedTo: { select: { id: true, name: true } },
      comments: {
        include: { author: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!ticket) notFound();

  const sla = slaStatus(ticket.slaDeadline);
  const isAgent = ["ADMIN", "SUPERADMIN", "AGENT"].includes(session!.user.role);

  const agents = isAgent
    ? await prisma.user.findMany({
        where: { companyId: session!.user.companyId, role: { in: ["AGENT", "ADMIN"] } },
        select: { id: true, name: true },
      })
    : [];

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{ticket.title}</h1>
          <p className="text-sm text-gray-500 mt-1">
            #{ticket.id.slice(-6)} • Aberto por {ticket.createdBy.name} •{" "}
            {format(ticket.createdAt, "dd/MM/yyyy HH:mm", { locale: ptBR })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-full">{statusLabels[ticket.status]}</span>
          <span className="text-xs text-gray-500">{priorityLabels[ticket.priority]}</span>
          {sla === "breached" && <span className="text-xs text-red-600 font-medium">SLA violado</span>}
          {sla === "warning" && <span className="text-xs text-orange-500">SLA expirando</span>}
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border p-6 mb-6">
        <p className="whitespace-pre-wrap text-gray-700">{ticket.description}</p>
        {ticket.slaDeadline && (
          <p className="mt-4 text-xs text-gray-400">
            SLA: {format(ticket.slaDeadline, "dd/MM/yyyy HH:mm", { locale: ptBR })}
          </p>
        )}
      </div>

      {isAgent && (
        <TicketActions
          ticketId={ticket.id}
          currentStatus={ticket.status}
          currentPriority={ticket.priority}
          assignedToId={ticket.assignedToId}
          agents={agents}
        />
      )}

      <div className="bg-white rounded-2xl shadow-sm border p-6 mt-6">
        <h2 className="font-semibold mb-4">Comentários ({ticket.comments.length})</h2>
        <div className="space-y-4 mb-6">
          {ticket.comments.map((c) => (
            <div key={c.id} className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-bold shrink-0">
                {c.author.name[0].toUpperCase()}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium">{c.author.name}</span>
                  <span className="text-xs text-gray-400">{format(c.createdAt, "dd/MM HH:mm", { locale: ptBR })}</span>
                </div>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{c.body}</p>
              </div>
            </div>
          ))}
          {ticket.comments.length === 0 && <p className="text-sm text-gray-400">Nenhum comentário ainda</p>}
        </div>

        {ticket.status !== "CLOSED" && <CommentForm ticketId={ticket.id} />}
      </div>
    </div>
  );
}
