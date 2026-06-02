"use client";

import { useState } from "react";

export default function ChangePasswordForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setSuccess("");
    const form = new FormData(e.currentTarget);
    const newPassword = form.get("newPassword") as string;
    const confirm = form.get("confirm") as string;

    if (newPassword !== confirm) { setError("As senhas não coincidem"); return; }

    setLoading(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: form.get("currentPassword"),
        newPassword,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) setError(typeof data.error === "string" ? data.error : "Erro ao alterar senha");
    else {
      setSuccess("Senha alterada com sucesso!");
      (e.target as HTMLFormElement).reset();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Senha atual</label>
        <input
          name="currentPassword"
          type="password"
          required
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Nova senha</label>
        <input
          name="newPassword"
          type="password"
          required
          minLength={6}
          placeholder="Mínimo 6 caracteres"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Confirmar nova senha</label>
        <input
          name="confirm"
          type="password"
          required
          placeholder="Repita a nova senha"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded-lg">{error}</p>}
      {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded-lg">{success}</p>}
      <button
        disabled={loading}
        className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
      >
        {loading ? "Salvando..." : "Alterar senha"}
      </button>
    </form>
  );
}
