import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import CreateCompanyForm from "./CreateCompanyForm";
import DeleteCompanyButton from "./DeleteCompanyButton";

export default async function CompaniesPage() {
  const session = await auth();
  if (session!.user.role !== "SUPERADMIN") redirect("/dashboard");

  const companies = await prisma.company.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { users: true, tickets: true } },
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Empresas</h1>
        <span className="text-sm text-gray-500">{companies.length} empresa{companies.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-3">
          {companies.map((c) => (
            <div key={c.id} className="bg-white rounded-2xl shadow-sm border p-5 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-gray-900">{c.name}</p>
                  {c.id === session!.user.companyId && (
                    <span className="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full">sua empresa</span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-0.5">/{c.slug}</p>
                <div className="flex gap-4 mt-2 text-xs text-gray-500">
                  <span>👤 {c._count.users} usuário{c._count.users !== 1 ? "s" : ""}</span>
                  <span>🎫 {c._count.tickets} ticket{c._count.tickets !== 1 ? "s" : ""}</span>
                  <span>📅 {format(c.createdAt, "dd/MM/yyyy", { locale: ptBR })}</span>
                </div>
              </div>
              {c.id !== session!.user.companyId && (
                <DeleteCompanyButton companyId={c.id} companyName={c.name} />
              )}
            </div>
          ))}
          {companies.length === 0 && (
            <div className="bg-white rounded-2xl border p-10 text-center text-gray-400 text-sm">
              Nenhuma empresa cadastrada
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Nova empresa</h2>
          <CreateCompanyForm />
        </div>
      </div>
    </div>
  );
}
