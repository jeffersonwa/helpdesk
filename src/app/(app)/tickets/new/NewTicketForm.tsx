"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { createTicketAction } from "../actions";

interface Option {
  id: string;
  name: string;
}
interface CategoryOpt extends Option {
  serviceId: string | null;
}
interface SubcategoryOpt extends Option {
  categoryId: string;
}
interface ItemOpt extends Option {
  subcategoryId: string;
}

interface Props {
  services: Option[];
  categories: CategoryOpt[];
  subcategories: SubcategoryOpt[];
  items: ItemOpt[];
  queues: Option[];
  teams: Option[];
  units: Option[];
  departments: Option[];
}

/** Matriz impacto × urgência (espelha derivePriority) — exibição read-only. */
const PRIORITY_MATRIX: Record<string, Record<string, string>> = {
  HIGH: { HIGH: "CRITICAL", MEDIUM: "HIGH", LOW: "MEDIUM" },
  MEDIUM: { HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" },
  LOW: { HIGH: "MEDIUM", MEDIUM: "LOW", LOW: "LOW" },
};
const priorityLabels: Record<string, string> = {
  LOW: "Baixa",
  MEDIUM: "Média",
  HIGH: "Alta",
  CRITICAL: "Crítica",
};

export default function NewTicketForm(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const [impact, setImpact] = useState("MEDIUM");
  const [urgency, setUrgency] = useState("MEDIUM");
  const [serviceId, setServiceId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");

  // Prioridade DERIVADA (read-only), coerente com o backend.
  const derivedPriority = PRIORITY_MATRIX[impact]?.[urgency] ?? "MEDIUM";

  // Selects dependentes do catálogo.
  const categoriesForService = useMemo(
    () => (serviceId ? props.categories.filter((c) => c.serviceId === serviceId) : props.categories),
    [serviceId, props.categories],
  );
  const subcategoriesForCategory = useMemo(
    () => props.subcategories.filter((s) => s.categoryId === categoryId),
    [categoryId, props.subcategories],
  );
  const itemsForSubcategory = useMemo(
    () => props.items.filter((i) => i.subcategoryId === subcategoryId),
    [subcategoryId, props.items],
  );

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await createTicketAction({
        title: String(fd.get("title") ?? ""),
        description: String(fd.get("description") ?? ""),
        impact,
        urgency,
        serviceId: serviceId || undefined,
        categoryId: categoryId || undefined,
        subcategoryId: subcategoryId || undefined,
        categoryItemId: String(fd.get("categoryItemId") ?? "") || undefined,
        queueId: String(fd.get("queueId") ?? "") || undefined,
        teamId: String(fd.get("teamId") ?? "") || undefined,
        unitId: String(fd.get("unitId") ?? "") || undefined,
        departmentId: String(fd.get("departmentId") ?? "") || undefined,
      });
      if (!res.ok) {
        setError(res.error);
      } else {
        router.push(`/tickets/${res.ticketId}`);
      }
    });
  }

  const inputCls =
    "w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500";
  const selectCls = inputCls + " text-sm";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block text-sm font-medium mb-1">Título</label>
        <input name="title" required minLength={3} maxLength={200} className={inputCls} />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Descrição</label>
        <textarea name="description" required minLength={10} maxLength={5000} rows={5} className={inputCls} />
      </div>

      {/* Impacto × urgência → prioridade derivada */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Impacto</label>
          <select value={impact} onChange={(e) => setImpact(e.target.value)} className={selectCls}>
            <option value="LOW">Baixo</option>
            <option value="MEDIUM">Médio</option>
            <option value="HIGH">Alto</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Urgência</label>
          <select value={urgency} onChange={(e) => setUrgency(e.target.value)} className={selectCls}>
            <option value="LOW">Baixa</option>
            <option value="MEDIUM">Média</option>
            <option value="HIGH">Alta</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Prioridade (derivada)</label>
          <div className="w-full border rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600">
            {priorityLabels[derivedPriority]}
          </div>
        </div>
      </div>

      {/* Catálogo: serviço → categoria → subcategoria → item */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Serviço</label>
          <select
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value);
              setCategoryId("");
              setSubcategoryId("");
            }}
            className={selectCls}
          >
            <option value="">—</option>
            {props.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Categoria</label>
          <select
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setSubcategoryId("");
            }}
            className={selectCls}
          >
            <option value="">—</option>
            {categoriesForService.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Subcategoria</label>
          <select
            name="_sub"
            value={subcategoryId}
            onChange={(e) => setSubcategoryId(e.target.value)}
            disabled={!categoryId}
            className={selectCls}
          >
            <option value="">—</option>
            {subcategoriesForCategory.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Item</label>
          <select name="categoryItemId" disabled={!subcategoryId} className={selectCls} defaultValue="">
            <option value="">—</option>
            {itemsForSubcategory.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Roteamento organizacional */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Fila</label>
          <select name="queueId" className={selectCls} defaultValue="">
            <option value="">—</option>
            {props.queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Time</label>
          <select name="teamId" className={selectCls} defaultValue="">
            <option value="">—</option>
            {props.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Unidade</label>
          <select name="unitId" className={selectCls} defaultValue="">
            <option value="">—</option>
            {props.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Departamento</label>
          <select name="departmentId" className={selectCls} defaultValue="">
            <option value="">—</option>
            {props.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="text-red-500 text-sm">{error}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => router.back()}
          className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50"
        >
          Cancelar
        </button>
        <button
          disabled={pending}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? "Criando..." : "Criar ticket"}
        </button>
      </div>
    </form>
  );
}
