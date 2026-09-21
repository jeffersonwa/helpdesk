"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createQueueAction } from "./actions";

export default function CreateQueueForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setSuccess("");
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "");
    const isDefault = form.get("isDefault") === "on";
    const el = e.currentTarget;

    startTransition(async () => {
      const res = await createQueueAction({ name, isDefault });
      if (!res.ok) {
        setError(res.error);
      } else {
        setSuccess("Fila criada com sucesso!");
        el.reset();
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Nome *</label>
        <input
          name="name"
          required
          maxLength={120}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input name="isDefault" type="checkbox" className="rounded border-gray-300" />
        Fila padrão do tenant
      </label>
      {error && <p className="text-red-500 text-xs bg-red-50 p-2 rounded-lg">{error}</p>}
      {success && <p className="text-green-600 text-xs bg-green-50 p-2 rounded-lg">{success}</p>}
      <button
        disabled={pending}
        className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
      >
        {pending ? "Criando..." : "Criar fila"}
      </button>
    </form>
  );
}
