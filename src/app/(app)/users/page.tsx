import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import AddUserForm from "./AddUserForm";

const roleLabels: Record<string, string> = {
  SUPERADMIN: "Super Admin",
  ADMIN: "Admin",
  AGENT: "Agente",
  CLIENT: "Cliente",
};

export default async function UsersPage() {
  const session = await auth();
  if (!["ADMIN", "SUPERADMIN"].includes(session!.user.role)) redirect("/dashboard");

  const users = await prisma.user.findMany({
    where: { companyId: session!.user.companyId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Usuários</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Nome</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Perfil</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Criado</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{u.name}</td>
                  <td className="px-4 py-3 text-gray-500">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs bg-gray-100 px-2 py-1 rounded-full">{roleLabels[u.role]}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{format(u.createdAt, "dd/MM/yyyy", { locale: ptBR })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold mb-4">Adicionar usuário</h2>
          <AddUserForm />
        </div>
      </div>
    </div>
  );
}
