"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Priority, TicketStatus } from "@prisma/client";

const statusLabels: Record<TicketStatus, string> = {
  OPEN: "Aberto",
  IN_PROGRESS: "Em andamento",
  WAITING: "Aguardando",
  PENDING_APPROVAL: "Aguardando aprovação",
  RESOLVED: "Resolvido",
  CLOSED: "Fechado",
};

const priorityLabels: Record<Priority, string> = {
  LOW: "Baixa",
  MEDIUM: "Média",
  HIGH: "Alta",
  CRITICAL: "Crítica",
};

interface Props {
  ticketId: string;
  currentStatus: TicketStatus;
  currentPriority: Priority;
  assignedToId: string | null;
  agents: { id: string; name: string }[];
}

export default function TicketActions({ ticketId, currentStatus, currentPriority, assignedToId, agents }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function update(data: Record<string, string>) {
    setLoading(true);
    await fetch(`/api/tickets/${ticketId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border p-6">
      <h2 className="font-semibold mb-4">Ações</h2>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Status</label>
          <select
            disabled={loading}
            defaultValue={currentStatus}
            onChange={(e) => update({ status: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {Object.entries(statusLabels).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Prioridade</label>
          <select
            disabled={loading}
            defaultValue={currentPriority}
            onChange={(e) => update({ priority: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {Object.entries(priorityLabels).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Responsável</label>
          <select
            disabled={loading}
            defaultValue={assignedToId ?? ""}
            onChange={(e) => update({ assignedToId: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Sem responsável</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
