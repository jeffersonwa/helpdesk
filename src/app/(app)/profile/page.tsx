import { auth } from "@/lib/auth";
import ChangePasswordForm from "./ChangePasswordForm";

export default async function ProfilePage() {
  const session = await auth();

  const roleLabels: Record<string, string> = {
    SUPERADMIN: "Super Admin",
    ADMIN: "Admin",
    AGENT: "Agente",
    CLIENT: "Cliente",
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Minha Conta</h1>

      {/* Dados do perfil */}
      <div className="bg-white rounded-2xl shadow-sm border p-6 mb-6">
        <h2 className="font-semibold text-gray-900 mb-4">Informações pessoais</h2>
        <div className="flex items-center gap-4 mb-4">
          <div className="w-14 h-14 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-2xl font-bold">
            {session!.user.name[0].toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-gray-900 text-lg">{session!.user.name}</p>
            <p className="text-gray-500 text-sm">{session!.user.email}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-gray-500 text-xs mb-1">Perfil</p>
            <p className="font-medium text-gray-900">{roleLabels[session!.user.role] ?? session!.user.role}</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-gray-500 text-xs mb-1">Empresa</p>
            <p className="font-medium text-gray-900">{session!.user.companyName}</p>
          </div>
        </div>
      </div>

      {/* Trocar senha */}
      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Alterar senha</h2>
        <ChangePasswordForm />
      </div>
    </div>
  );
}
