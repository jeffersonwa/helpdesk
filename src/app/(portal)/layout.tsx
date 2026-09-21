import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import PortalHeader from "./PortalHeader";

/**
 * Layout do portal de autoatendimento (grupo de rotas `(portal)`).
 *
 * Tarefa 34.1. Distinto do console de atendimento (`(app)/layout.tsx`): é um
 * layout leve destinado a SOLICITANTES/clientes — cabeçalho simples, sem o
 * sidebar administrativo. A autorização real permanece no backend; aqui
 * apenas garantimos que há sessão (Req. 14.1, 14.4).
 *
 * Isolamento de tenant: o `companyId` de toda leitura das páginas filhas é
 * SEMPRE derivado da sessão do servidor (nunca do corpo/URL) — princípio
 * inviolável de multi-tenancy (Req. 1.1–1.3, 14.4).
 */
export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-50">
      <PortalHeader
        userName={session.user.name || session.user.email}
        companyName={session.user.companyName}
      />
      <main className="max-w-4xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
