import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { KnowledgeBaseService, defaultKbClient } from "@/lib/kb/service";
import { TicketStatus } from "@prisma/client";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { BookOpen, Ticket, Plus, ArrowRight } from "lucide-react";

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
 * Início do portal de autoatendimento (tarefa 34.1).
 *
 * Server Component: mostra os artigos publicados do tenant (Req. 14.2) e os
 * chamados DO PRÓPRIO solicitante autenticado (`createdById` da sessão),
 * escopados por `companyId` (Req. 14.1, 14.4). Nada vem do corpo/URL — tudo da
 * sessão do servidor (Req. 1.1–1.3).
 */
export default async function PortalHomePage() {
  const session = await auth();
  const companyId = session!.user.companyId;
  const userId = session!.user.id;

  const [articles, tickets] = await Promise.all([
    KnowledgeBaseService.listPublished(defaultKbClient(), companyId),
    prisma.ticket.findMany({
      where: { companyId, createdById: userId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, title: true, status: true, createdAt: true },
    }),
  ]);

  const topArticles = articles.slice(0, 4);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Olá, {session!.user.name || "bem-vindo"}</h1>
        <p className="text-gray-500 mt-1">
          Encontre respostas na base de conhecimento ou acompanhe seus chamados.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/tickets/new"
          className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700"
        >
          <Plus size={18} /> Abrir novo chamado
        </Link>
        <Link
          href="/portal/kb"
          className="inline-flex items-center gap-2 bg-white border px-4 py-2.5 rounded-xl text-sm font-medium text-gray-700 hover:border-blue-300"
        >
          <BookOpen size={18} /> Base de conhecimento
        </Link>
      </div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <BookOpen className="text-blue-600" size={20} />
            <h2 className="font-semibold">Artigos em destaque</h2>
          </div>
          <Link href="/portal/kb" className="text-sm text-blue-600 inline-flex items-center gap-1 hover:underline">
            Ver todos <ArrowRight size={14} />
          </Link>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          {topArticles.map((a) => (
            <Link
              key={a.id}
              href={`/portal/kb/${a.id}`}
              className="block bg-white rounded-2xl border shadow-sm p-5 hover:border-blue-300 transition-colors"
            >
              <h3 className="font-medium text-gray-900">{a.title}</h3>
              <p className="text-sm text-gray-500 mt-1 line-clamp-2">{a.body}</p>
            </Link>
          ))}
          {topArticles.length === 0 && (
            <div className="sm:col-span-2 bg-white rounded-2xl border shadow-sm p-6 text-center text-gray-400">
              Nenhum artigo publicado ainda.
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Ticket className="text-blue-600" size={20} />
            <h2 className="font-semibold">Meus chamados recentes</h2>
          </div>
          <Link href="/portal/tickets" className="text-sm text-blue-600 inline-flex items-center gap-1 hover:underline">
            Ver todos <ArrowRight size={14} />
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
                </p>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColors[t.status]}`}>
                {statusLabels[t.status]}
              </span>
            </Link>
          ))}
          {tickets.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-gray-400">
              Você ainda não abriu nenhum chamado.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
