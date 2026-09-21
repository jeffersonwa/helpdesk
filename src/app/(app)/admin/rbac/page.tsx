import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import RbacForms from "./RbacForms";

export default async function RbacAdminPage() {
  const session = await auth();
  // Guard de UX: apenas ADMIN/SUPERADMIN veem a página. A autorização REAL
  // (rbac.manage) é aplicada no backend pelas server actions / rbac service.
  if (!["ADMIN", "SUPERADMIN"].includes(session!.user.role)) redirect("/dashboard");
  const companyId = session!.user.companyId;

  // Papéis do tenant + papéis globais de plataforma (companyId null, Req. 3.6).
  const roles = await prisma.roleDef.findMany({
    where: { OR: [{ companyId }, { companyId: null }] },
    orderBy: { name: "asc" },
    include: { permissions: { select: { action: true } }, _count: { select: { assignments: true } } },
  });

  const users = await prisma.user.findMany({
    where: { companyId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });

  const roleOptions = roles.map((r) => ({ id: r.id, name: r.name }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Papéis e permissões</h1>
        <span className="text-sm text-gray-500">
          {roles.length} papel{roles.length !== 1 ? "éis" : ""}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          {roles.map((r) => (
            <div key={r.id} className="bg-white rounded-2xl shadow-sm border p-5">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-gray-900">{r.name}</h2>
                  {r.companyId === null && (
                    <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded-full">Global</span>
                  )}
                </div>
                <span className="text-xs text-gray-400">{r._count.assignments} atribuição(ões)</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {r.permissions.map((p) => (
                  <code key={p.action} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                    {p.action}
                  </code>
                ))}
                {r.permissions.length === 0 && <span className="text-xs text-gray-400">Sem permissões</span>}
              </div>
            </div>
          ))}
          {roles.length === 0 && (
            <div className="bg-white rounded-2xl shadow-sm border p-10 text-center text-gray-400 text-sm">
              Nenhum papel cadastrado
            </div>
          )}
        </div>

        <div>
          <RbacForms permissions={[...PERMISSIONS]} roles={roleOptions} users={users} />
        </div>
      </div>
    </div>
  );
}
