import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import CreateQueueForm from "./CreateQueueForm";

export default async function QueuesPage() {
  const session = await auth();
  if (!["ADMIN", "SUPERADMIN", "SERVICE_MANAGER", "SUPERVISOR"].includes(session!.user.role)) {
    redirect("/dashboard");
  }
  const companyId = session!.user.companyId;

  // Filas do tenant + contagem de tickets por fila (escopo por companyId).
  const queues = await prisma.queue.findMany({
    where: { companyId },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    include: { _count: { select: { tickets: true } } },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Filas</h1>
        <span className="text-sm text-gray-500">
          {queues.length} fila{queues.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Fila</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Padrão</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Tickets</th>
                </tr>
              </thead>
              <tbody>
                {queues.map((q) => (
                  <tr key={q.id} className="border-b last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-800">{q.name}</td>
                    <td className="px-4 py-3">
                      {q.isDefault ? (
                        <span className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full">Padrão</span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{q._count.tickets}</td>
                  </tr>
                ))}
                {queues.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-10 text-center text-gray-400">
                      Nenhuma fila cadastrada
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold mb-4 text-gray-900">Nova fila</h2>
          <CreateQueueForm />
        </div>
      </div>
    </div>
  );
}
