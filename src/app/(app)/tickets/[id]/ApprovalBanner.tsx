"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ApprovalBanner({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState<"approve" | "reject" | null>(null);

  async function decide(action: "approve" | "reject") {
    setLoading(action);
    const res = await fetch(`/api/tickets/${ticketId}/approve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setLoading(null);
    if (res.ok) router.refresh();
  }

  return (
    <div className="bg-amber-50 border border-amber-300 rounded-2xl p-6 mb-6">
      <div className="flex items-start gap-3">
        <span className="text-2xl">⏳</span>
        <div className="flex-1">
          <h2 className="font-semibold text-amber-800 mb-1">Solução aguardando sua aprovação</h2>
          <p className="text-sm text-amber-700 mb-4">
            O agente marcou este chamado como resolvido. O problema foi solucionado?
          </p>
          <div className="flex gap-3">
            <button
              disabled={loading !== null}
              onClick={() => decide("approve")}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
            >
              {loading === "approve" ? "Aprovando..." : "✓ Sim, problema resolvido"}
            </button>
            <button
              disabled={loading !== null}
              onClick={() => decide("reject")}
              className="px-4 py-2 bg-red-100 text-red-700 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-200 disabled:opacity-50 flex items-center gap-2"
            >
              {loading === "reject" ? "Rejeitando..." : "✗ Não, ainda preciso de ajuda"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
