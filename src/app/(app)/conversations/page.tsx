import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ConversationState, ChannelType } from "@prisma/client";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

const stateColors: Record<ConversationState, string> = {
  OPEN: "bg-blue-100 text-blue-700",
  PENDING: "bg-yellow-100 text-yellow-700",
  RESOLVED: "bg-green-100 text-green-700",
  EXPIRED: "bg-gray-100 text-gray-600",
};

const stateLabels: Record<ConversationState, string> = {
  OPEN: "Aberta",
  PENDING: "Pendente",
  RESOLVED: "Resolvida",
  EXPIRED: "Expirada",
};

const channelLabels: Record<ChannelType, string> = {
  WEB: "Portal",
  WHATSAPP: "WhatsApp",
  EMAIL: "E-mail",
  PUBLIC_FORM: "Formulário",
  API: "API",
};

export default async function ConversationsPage() {
  const session = await auth();
  const companyId = session!.user.companyId;

  // Isolamento de tenant: SEMPRE filtrado pelo companyId da sessão do servidor.
  const conversations = await prisma.conversation.findMany({
    where: { companyId },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      channelAccount: { select: { type: true, label: true } },
      tickets: { select: { id: true, number: true }, orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { messages: true } },
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Conversas</h1>
        <span className="text-sm text-gray-500">
          {conversations.length} conversa{conversations.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Contato</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Canal</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Estado</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Ticket</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Última atividade</th>
            </tr>
          </thead>
          <tbody>
            {conversations.map((c) => {
              const ticket = c.tickets[0];
              return (
                <tr key={c.id} className="border-b last:border-0 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/conversations/${c.id}`} className="font-medium hover:text-blue-600">
                      {c.contactName || c.contactExternalId}
                    </Link>
                    {c._count.messages > 0 && (
                      <span className="ml-2 text-xs text-gray-400">{c._count.messages} mensagens</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {channelLabels[c.channelAccount.type]}
                    <span className="text-xs text-gray-400"> • {c.channelAccount.label}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-1 rounded-full ${stateColors[c.state]}`}>{stateLabels[c.state]}</span>
                  </td>
                  <td className="px-4 py-3">
                    {ticket ? (
                      <Link href={`/tickets/${ticket.id}`} className="text-xs text-blue-600 hover:underline">
                        #{ticket.number}
                      </Link>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {formatDistanceToNow(c.updatedAt, { locale: ptBR, addSuffix: true })}
                  </td>
                </tr>
              );
            })}
            {conversations.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-gray-400">
                  Nenhuma conversa encontrada
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
