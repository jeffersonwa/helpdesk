import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { ChannelType } from "@prisma/client";
import ChannelForm from "./ChannelForm";

const typeLabels: Record<ChannelType, string> = {
  WEB: "Portal",
  WHATSAPP: "WhatsApp",
  EMAIL: "E-mail",
  PUBLIC_FORM: "Formulário",
  API: "API",
};

export default async function ChannelsAdminPage() {
  const session = await auth();
  // Guard de UX; a autorização real (channel.configure) é aplicada no backend.
  if (!["ADMIN", "SUPERADMIN"].includes(session!.user.role)) redirect("/dashboard");
  const companyId = session!.user.companyId;

  const channels = await prisma.channelAccount.findMany({
    where: { companyId },
    orderBy: { label: "asc" },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Canais</h1>
        <span className="text-sm text-gray-500">
          {channels.length} canal{channels.length !== 1 ? "is" : ""}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Rótulo</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Tipo</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Provedor</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Ativo</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {c.label}
                      <span className="block text-xs text-gray-400 font-normal">ref: {c.secretRef}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{typeLabels[c.type]}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{c.provider}</td>
                    <td className="px-4 py-3">
                      {c.active ? (
                        <span className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded-full">Ativo</span>
                      ) : (
                        <span className="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded-full">Inativo</span>
                      )}
                    </td>
                  </tr>
                ))}
                {channels.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-gray-400">
                      Nenhum canal cadastrado
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold mb-4 text-gray-900">Registrar canal</h2>
          <ChannelForm />
        </div>
      </div>
    </div>
  );
}
