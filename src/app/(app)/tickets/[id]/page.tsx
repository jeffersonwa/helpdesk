import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { Impact, Priority, TicketStatus, Urgency } from "@prisma/client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { slaStatus } from "@/lib/sla";
import TicketActions from "./TicketActions";
import CommentForm from "./CommentForm";
import ApprovalBanner from "./ApprovalBanner";

const statusLabels: Record<TicketStatus, string> = {
  OPEN: "Aberto",
  IN_PROGRESS: "Em andamento",
  WAITING: "Aguardando",
  PENDING_APPROVAL: "Aguardando aprovação",
  RESOLVED: "Resolvido",
  CLOSED: "Fechado",
};

const statusColors: Record<TicketStatus, string> = {
  OPEN: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-yellow-100 text-yellow-700",
  WAITING: "bg-purple-100 text-purple-700",
  PENDING_APPROVAL: "bg-amber-100 text-amber-700",
  RESOLVED: "bg-green-100 text-green-700",
  CLOSED: "bg-gray-100 text-gray-600",
};

const priorityLabels: Record<Priority, string> = {
  LOW: "Baixa",
  MEDIUM: "Média",
  HIGH: "Alta",
  CRITICAL: "Crítica",
};

const levelLabels: Record<Impact | Urgency, string> = {
  LOW: "Baixo",
  MEDIUM: "Médio",
  HIGH: "Alto",
};

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const { id } = await params;
  const ticket = await prisma.ticket.findFirst({
    where: { id, companyId: session!.user.companyId },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      assignedTo: { select: { id: true, name: true } },
      queue: { select: { name: true } },
      comments: {
        include: { author: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!ticket) notFound();

  // Resolve nomes das classificações (IDs armazenados no ticket). Todas as
  // buscas são escopadas por companyId da sessão (isolamento de tenant).
  const companyId = session!.user.companyId;
  const [service, category, subcategory, categoryItem, unit, department, team] = await Promise.all([
    ticket.serviceId
      ? prisma.catalogService.findFirst({ where: { id: ticket.serviceId, companyId }, select: { name: true } })
      : null,
    ticket.categoryId
      ? prisma.category.findFirst({ where: { id: ticket.categoryId, companyId }, select: { name: true } })
      : null,
    ticket.subcategoryId
      ? prisma.subcategory.findFirst({ where: { id: ticket.subcategoryId, category: { companyId } }, select: { name: true } })
      : null,
    ticket.categoryItemId
      ? prisma.categoryItem.findFirst({
          where: { id: ticket.categoryItemId, subcategory: { category: { companyId } } },
          select: { name: true },
        })
      : null,
    ticket.unitId ? prisma.orgUnit.findFirst({ where: { id: ticket.unitId, companyId }, select: { name: true } }) : null,
    ticket.departmentId
      ? prisma.department.findFirst({ where: { id: ticket.departmentId, companyId }, select: { name: true } })
      : null,
    ticket.teamId ? prisma.team.findFirst({ where: { id: ticket.teamId, companyId }, select: { name: true } }) : null,
  ]);

  const classification: { label: string; value: string }[] = [
    { label: "Impacto", value: levelLabels[ticket.impact] },
    { label: "Urgência", value: levelLabels[ticket.urgency] },
    { label: "Prioridade", value: priorityLabels[ticket.priority] },
    { label: "Fila", value: ticket.queue?.name ?? "—" },
    { label: "Time", value: team?.name ?? "—" },
    { label: "Unidade", value: unit?.name ?? "—" },
    { label: "Departamento", value: department?.name ?? "—" },
    { label: "Serviço", value: service?.name ?? "—" },
    { label: "Categoria", value: category?.name ?? "—" },
    { label: "Subcategoria", value: subcategory?.name ?? "—" },
    { label: "Item", value: categoryItem?.name ?? "—" },
  ];

  const sla = slaStatus(ticket.slaDeadline);
  const isAgent = ["ADMIN", "SUPERADMIN", "AGENT"].includes(session!.user.role);
  const isCreator = session!.user.id === ticket.createdBy.id;
  const showApprovalBanner = ticket.status === "PENDING_APPROVAL" && isCreator;

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
          <h1 className="text-2xl font-bold text-gray-900">{ticket.title}</h1>
          <p className="text-sm text-gray-500 mt-1">
            #{ticket.id.slice(-6)} • Aberto por {ticket.createdBy.name} •{" "}
            {format(ticket.createdAt, "dd/MM/yyyy HH:mm", { locale: ptBR })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColors[ticket.status]}`}>
            {statusLabels[ticket.status]}
          </span>
          <span className="text-xs text-gray-500">{priorityLabels[ticket.priority]}</span>
          {sla === "breached" && <span className="text-xs text-red-600 font-medium">SLA violado</span>}
          {sla === "warning" && <span className="text-xs text-orange-500">SLA expirando</span>}
        </div>
      </div>

      {/* Banner de aprovação — visível apenas para o criador quando PENDING_APPROVAL */}
      {showApprovalBanner && <ApprovalBanner ticketId={ticket.id} />}

      <div className="bg-white rounded-2xl shadow-sm border p-6 mb-6">
        <p className="whitespace-pre-wrap text-gray-700">{ticket.description}</p>
        {ticket.slaDeadline && (
          <p className="mt-4 text-xs text-gray-400">
            SLA: {format(ticket.slaDeadline, "dd/MM/yyyy HH:mm", { locale: ptBR })}
          </p>
        )}
      </div>

      {/* Classificação (impacto/urgência/prioridade + catálogo + roteamento) */}
      <div className="bg-white rounded-2xl shadow-sm border p-6 mb-6">
        <h2 className="font-semibold mb-4 text-gray-900">Classificação</h2>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {classification.map((c) => (
            <div key={c.label}>
              <dt className="text-xs text-gray-400">{c.label}</dt>
              <dd className="text-sm text-gray-800">{c.value}</dd>
            </div>
          ))}
        </dl>
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
        <h2 className="font-semibold mb-4 text-gray-900">Comentários ({ticket.comments.length})</h2>
        <div className="space-y-4 mb-6">
          {ticket.comments.map((c) => (
            <div key={c.id} className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-bold shrink-0">
                {c.author.name[0].toUpperCase()}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-gray-800">{c.author.name}</span>
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
