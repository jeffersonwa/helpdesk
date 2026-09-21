"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createRoleAction, assignRoleAction } from "./actions";

interface Props {
  permissions: string[];
  roles: { id: string; name: string }[];
  users: { id: string; name: string; email: string }[];
}

export default function RbacForms({ permissions, roles, users }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [selected, setSelected] = useState<string[]>([]);
  const [roleError, setRoleError] = useState("");
  const [roleSuccess, setRoleSuccess] = useState("");

  const [assignError, setAssignError] = useState("");
  const [assignSuccess, setAssignSuccess] = useState("");

  function toggle(perm: string) {
    setSelected((s) => (s.includes(perm) ? s.filter((p) => p !== perm) : [...s, perm]));
  }

  function handleCreateRole(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setRoleError("");
    setRoleSuccess("");
    const f = e.currentTarget;
    const name = String(new FormData(f).get("name") ?? "");
    startTransition(async () => {
      const res = await createRoleAction({ name, permissions: selected, tenantScope: true });
      if (!res.ok) {
        setRoleError(res.error);
      } else {
        setRoleSuccess("Papel criado com sucesso!");
        setSelected([]);
        f.reset();
        router.refresh();
      }
    });
  }

  function handleAssign(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAssignError("");
    setAssignSuccess("");
    const fd = new FormData(e.currentTarget);
    const userId = String(fd.get("userId") ?? "");
    const roleDefId = String(fd.get("roleDefId") ?? "");
    startTransition(async () => {
      const res = await assignRoleAction({ userId, roleDefId });
      if (!res.ok) {
        setAssignError(res.error);
      } else {
        setAssignSuccess("Papel atribuído com sucesso!");
        router.refresh();
      }
    });
  }

  const inputCls =
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500";
  const btnCls =
    "w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-60";

  return (
    <div className="space-y-6">
      {/* Criar papel customizado */}
      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <h2 className="font-semibold mb-4 text-gray-900">Novo papel</h2>
        <form onSubmit={handleCreateRole} className="space-y-3">
          <input name="name" required maxLength={100} placeholder="Nome do papel" className={inputCls} />
          <div>
            <label className="block text-xs text-gray-500 mb-1">Permissões</label>
            <div className="max-h-56 overflow-auto border border-gray-200 rounded-lg p-2 space-y-1">
              {permissions.map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={selected.includes(p)}
                    onChange={() => toggle(p)}
                    className="rounded border-gray-300"
                  />
                  <code className="text-xs">{p}</code>
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1">{selected.length} selecionada(s) • escopo do tenant</p>
          </div>
          {roleError && <p className="text-red-500 text-xs bg-red-50 p-2 rounded-lg">{roleError}</p>}
          {roleSuccess && <p className="text-green-600 text-xs bg-green-50 p-2 rounded-lg">{roleSuccess}</p>}
          <button disabled={pending || selected.length === 0} className={btnCls}>
            Criar papel
          </button>
        </form>
      </div>

      {/* Atribuir papel */}
      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <h2 className="font-semibold mb-4 text-gray-900">Atribuir papel</h2>
        <form onSubmit={handleAssign} className="space-y-3">
          <select name="userId" required className={inputCls} defaultValue="">
            <option value="" disabled>
              Selecione o usuário
            </option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
          <select name="roleDefId" required className={inputCls} defaultValue="">
            <option value="" disabled>
              Selecione o papel
            </option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {assignError && <p className="text-red-500 text-xs bg-red-50 p-2 rounded-lg">{assignError}</p>}
          {assignSuccess && <p className="text-green-600 text-xs bg-green-50 p-2 rounded-lg">{assignSuccess}</p>}
          <button disabled={pending || roles.length === 0} className={btnCls}>
            Atribuir
          </button>
        </form>
      </div>
    </div>
  );
}
