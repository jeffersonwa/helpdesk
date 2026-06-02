import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import AddUserForm from "./AddUserForm";
import UsersTable from "./UsersTable";

export default async function UsersPage() {
  const session = await auth();
  if (!["ADMIN", "SUPERADMIN"].includes(session!.user.role)) redirect("/dashboard");

  const users = await prisma.user.findMany({
    where: { companyId: session!.user.companyId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, email: true, role: true, phone: true, mobile: true, createdAt: true },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Usuários</h1>
        <span className="text-sm text-gray-500">{users.length} usuário{users.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <UsersTable users={users} currentUserId={session!.user.id} currentRole={session!.user.role} />
        </div>
        <div className="bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold mb-4 text-gray-900">Adicionar usuário</h2>
          <AddUserForm />
        </div>
      </div>
    </div>
  );
}
