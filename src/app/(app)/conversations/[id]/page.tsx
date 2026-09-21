import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { MessageDirection, ChannelType } from "@prisma/client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import Link from "next/link";

const channelLabels: Record<ChannelType, string> = {
  WEB: "Portal",
  WHATSAPP: "WhatsApp",
  EMAIL: "E-mail",
  PUBLIC_FORM: "Formulário",
  API: "API",
};

export default async function ConversationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const { id } = await params;

  // Leitura escopada por tenant (companyId da sessão): findFirst com companyId
  // garante que uma conversa de outro tenant retorne "não encontrada".
  const conversation = await prisma.conversation.findFirst({
    where: { id, companyId: session!.user.companyId },
    include: {
      channelAccount: { select: { type: true, label: true } },
      tickets: { select: { id: true, number: true, title: true }, orderBy: { createdAt: "desc" } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!conversation) notFound();

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {conversation.contactName || conversation.contactExternalId}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {channelLabels[conversation.channelAccount.type]} • {conversation.channelAccount.label} •{" "}
            {conversation.messages.length} mensagens
          </p>
        </div>
        <Link href="/conversations" className="text-sm text-gray-500 hover:text-blue-600">
          ← Voltar
        </Link>
      </div>

      {conversation.tickets.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm border p-4 mb-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Tickets vinculados</h2>
          <div className="flex flex-wrap gap-2">
            {conversation.tickets.map((t) => (
              <Link
                key={t.id}
                href={`/tickets/${t.id}`}
                className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full hover:bg-blue-100"
              >
                #{t.number} {t.title}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <h2 className="font-semibold mb-4 text-gray-900">Mensagens</h2>
        <div className="space-y-4">
          {conversation.messages.map((m) => {
            const outbound = m.direction === MessageDirection.OUTBOUND;
            return (
              <div key={m.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                    outbound ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {m.body && <p className="whitespace-pre-wrap">{m.body}</p>}
                  {m.mediaUrl && (
                    <p className={`text-xs mt-1 ${outbound ? "text-blue-100" : "text-gray-500"}`}>
                      [mídia: {m.type}]
                    </p>
                  )}
                  <p className={`text-[10px] mt-1 ${outbound ? "text-blue-100" : "text-gray-400"}`}>
                    {format(m.createdAt, "dd/MM HH:mm", { locale: ptBR })}
                  </p>
                </div>
              </div>
            );
          })}
          {conversation.messages.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">Nenhuma mensagem ainda</p>
          )}
        </div>
      </div>
    </div>
  );
}
