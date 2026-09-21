"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { REPORT_PERIODS, type ReportPeriodKey } from "./periods";

/**
 * Seletor de período do relatório (tarefa 35.1).
 *
 * Client Component no padrão `useState` + `useTransition` do repo. Atualiza o
 * query param `period`, que o Server Component (`page.tsx`) lê via
 * `searchParams` para recalcular as métricas. Não guarda estado de negócio —
 * apenas reflete a seleção na URL.
 */
export default function PeriodSelector({ current }: { current: ReportPeriodKey }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState<ReportPeriodKey>(current);
  const [isPending, startTransition] = useTransition();

  function onChange(next: ReportPeriodKey) {
    setValue(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", next);
    startTransition(() => {
      router.push(`/reports?${params.toString()}`);
    });
  }

  return (
    <div className="inline-flex rounded-xl border bg-white p-1">
      {(Object.entries(REPORT_PERIODS) as [ReportPeriodKey, { label: string }][]).map(
        ([key, { label }]) => {
          const active = value === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              disabled={isPending}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-60 ${
                active ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {label}
            </button>
          );
        },
      )}
    </div>
  );
}
