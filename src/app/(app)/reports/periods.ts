// Constantes puras de período do relatório.
//
// Isolado de `data.ts` porque este módulo é importado por um Client Component
// (`PeriodSelector.tsx`). O `data.ts` puxa `sessionToUser` → `@/lib/prisma`
// (adapter-pg → pg), que NÃO pode ir para o bundle do navegador. Mantendo as
// constantes aqui (sem imports de servidor), o client importa apenas isto.
import type { ReportPeriod } from "@/lib/reports/service";

/** Períodos suportados pelo seletor do dashboard (em dias). */
export const REPORT_PERIODS = {
  "7d": { label: "Últimos 7 dias", days: 7 },
  "30d": { label: "Últimos 30 dias", days: 30 },
  "90d": { label: "Últimos 90 dias", days: 90 },
} as const;

export type ReportPeriodKey = keyof typeof REPORT_PERIODS;

/** Chave de período default quando ausente/inválida na URL. */
export const DEFAULT_PERIOD: ReportPeriodKey = "30d";

/** Normaliza a chave de período vinda do `searchParams` (fail-safe → default). */
export function normalizePeriodKey(raw: string | undefined): ReportPeriodKey {
  if (raw && raw in REPORT_PERIODS) return raw as ReportPeriodKey;
  return DEFAULT_PERIOD;
}

/** Converte uma chave de período numa janela `{ from, to }` terminando em `now`. */
export function periodFromKey(key: ReportPeriodKey, now: Date = new Date()): ReportPeriod {
  const days = REPORT_PERIODS[key].days;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to: now };
}
