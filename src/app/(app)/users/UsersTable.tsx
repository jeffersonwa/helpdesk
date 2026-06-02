"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import EditUserModal from "./EditUserModal";
import ResetPasswordModal from "./ResetPasswordModal";

const roleLabels: Record<string, string> = {
  SUPERADMIN: "Super Admin",
  ADMIN: "Admin",
  AGENT: "Agente",
  CLIENT: "Cliente",
};

const roleColors: Record<string, string> = {
  SUPERADMIN: "bg-purple-100 text-purple-700",
  ADMIN: "bg-blue-100 text-blue-700",
  AGENT: "bg-green-100 text-green-700",
  CLIENT: "bg-gray-100 text-gray-600",
};

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  phone?: string | null;
  mobile?: string | null;
  createdAt: Date;
}

interface Props {
  users: User[];
  currentUserId: string;
  currentRole: string;
}

export default function UsersTable({ users, currentUserId, currentRole }: Props) {
  const router = useRouter();
  const [editUser, setEditUser] = useState<User | null>(null);
  const [resetUser, setResetUser] = useState<User | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      (u.phone ?? "").includes(search) ||
      (u.mobile ?? "").includes(search)
  );

  async function handleDelete(user: User) {
    if (!confirm(`Excluir o usuário "${user.name}"? Esta ação não pode ser desfeita.`)) return;
    setDeletingId(user.id);
    const res = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
    setDeletingId(null);
    if (res.ok) router.refresh();
    else {
      const data = await res.json();
      alert(data.error ?? "Erro ao excluir usuário");
    }
  }

  return (
    <>
      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        <div className="p-4 border-b">
          <input
            type="text"
            placeholder="Buscar por nome, email ou telefone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Usuário</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Contato</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Perfil</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Criado</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Ações</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className="border-b last:border-0 hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-bold shrink-0">
                      {u.name[0].toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">
                        {u.name}
                        {u.id === currentUserId && <span className="ml-2 text-xs text-gray-400">(você)</span>}
                      </p>
                      <p className="text-xs text-gray-400">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="text-xs text-gray-500 space-y-0.5">
                    {u.phone && <p>📞 {u.phone}</p>}
                    {u.mobile && <p>📱 {u.mobile}</p>}
                    {!u.phone && !u.mobile && <span className="text-gray-300">—</span>}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${roleColors[u.role]}`}>
                    {roleLabels[u.role]}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-400 text-xs">
                  {format(u.createdAt, "dd/MM/yyyy", { locale: ptBR })}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setEditUser(u)}
                      className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600 font-medium transition-colors">
                      Editar
                    </button>
                    <button onClick={() => setResetUser(u)}
                      className="text-xs px-3 py-1.5 border border-blue-200 rounded-lg hover:bg-blue-50 text-blue-600 font-medium transition-colors">
                      Senha
                    </button>
                    {u.id !== currentUserId && (
                      <button disabled={deletingId === u.id} onClick={() => handleDelete(u)}
                        className="text-xs px-3 py-1.5 border border-red-200 rounded-lg hover:bg-red-50 text-red-600 font-medium transition-colors disabled:opacity-50">
                        {deletingId === u.id ? "..." : "Excluir"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-gray-400 text-sm">
                  {search ? "Nenhum usuário encontrado" : "Nenhum usuário cadastrado"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editUser && (
        <EditUserModal user={editUser} currentRole={currentRole}
          onClose={() => setEditUser(null)}
          onSaved={() => { setEditUser(null); router.refresh(); }} />
      )}
      {resetUser && (
        <ResetPasswordModal user={resetUser} onClose={() => setResetUser(null)} />
      )}
    </>
  );
}
