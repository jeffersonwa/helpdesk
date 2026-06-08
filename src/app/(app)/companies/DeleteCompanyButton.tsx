"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  companyId: string;
  companyName: string;
}

export default function DeleteCompanyButton({ companyId, companyName }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDelete() {
    if (!confirm(`⚠️ Excluir a empresa "${companyName}"?\n\nIsso irá remover TODOS os usuários, tickets e dados desta empresa. Esta ação não pode ser desfeita.`)) return;

    setLoading(true);
    const res = await fetch(`/api/companies/${companyId}`, { method: "DELETE" });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      alert(data.error ?? "Erro ao excluir empresa");
    } else {
      router.refresh();
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={loading}
      className="text-xs px-3 py-1.5 border border-red-200 rounded-lg hover:bg-red-50 text-red-600 font-medium transition-colors disabled:opacity-50 shrink-0"
    >
      {loading ? "..." : "Excluir"}
    </button>
  );
}
