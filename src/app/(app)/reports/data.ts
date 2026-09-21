import {
  ReportsService,
  defaultReportsClient,
  type ReportMetrics,
  type ReportPeriod,
  type ReportsClient,
} from "@/lib/reports/service";
import { sessionToUser, type RbacSession, type SessionUserClient } from "@/lib/rbac/session-user";
import { scopeFromSessionUser } from "./scope";

/** Períodos suportados pelo seletor do dashboard (em dias). */
export const REPORT_PERIODS = {
  "7d": { label: "Últimos 7 dias", days: 7 },
  "30d": { label: "Últimos 30 dias", days: 30 },
  "90d": { label: "Últimos 90 dias", days: 90 },
} as const;

export type ReportPeriodKey = keyof typeof REPORT_PERIODS;

/** Chave de período default quando ausente/ inválida na URL. */
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

/** Resultado do carregamento de dados do relatório (sucesso ou erro). */
export type ReportLoad =
  | { ok: true; metrics: ReportMetrics; periodKey: ReportPeriodKey }
  | { ok: false; periodKey: ReportPeriodKey; error: string };

/**
 * Carrega as métricas do relatório para o usuário da sessão (tarefa 35.1).
 *
 * Isolamento + escopo (Req. 15.5, 15.6): materializa o {@link SessionUser} via
 * `sessionToUser` (companyId SEMPRE da sessão) e deriva um `ReportScope` dos
 * seus escopos RBAC. O `ReportsService` aplica `companyId` + escopo em todo
 * `where`.
 *
 * Período vazio (Req. 15.8): o próprio serviço zera as métricas quando não há
 * dados — nenhum tratamento extra é necessário aqui.
 *
 * Falha (Req. 15.7): qualquer erro no cálculo é capturado e devolvido como
 * `{ ok: false, error }`, para a página renderizar um estado de erro amigável
 * preservando a última visualização (o período selecionado é mantido).
 *
 * @param rawPeriod chave de período crua do `searchParams`.
 * @param deps injeção para testes (sessão + clients Prisma); em produção usa
 *   `auth()` e os clients padrão.
 */
export async function loadReport(
  rawPeriod: string | undefined,
  deps: {
    reports?: ReportsClient;
    sessionUserClient?: SessionUserClient;
    getSession?: () => Promise<RbacSession | null>;
    now?: Date;
  } = {},
): Promise<ReportLoad> {
  const periodKey = normalizePeriodKey(rawPeriod);

  try {
    const getSession =
      deps.getSession ??
      (async () => {
        const { auth } = await import("@/lib/auth");
        return (await auth()) as RbacSession | null;
      });

    const session = await getSession();
    const user = await sessionToUser(session, { prisma: deps.sessionUserClient });

    // Fail-closed: sem usuário materializado (sem sessão/tenant) → erro amigável.
    if (!user) {
      return { ok: false, periodKey, error: "Sessão inválida ou expirada." };
    }

    const scope = scopeFromSessionUser(user);
    const period = periodFromKey(periodKey, deps.now);
    const client = deps.reports ?? defaultReportsClient();

    const metrics = await ReportsService.computeMetrics(client, {
      companyId: user.companyId,
      period,
      scope,
    });

    return { ok: true, metrics, periodKey };
  } catch {
    // Req. 15.7: falha na geração → mensagem de erro, sem alterar dados.
    return {
      ok: false,
      periodKey,
      error: "Não foi possível gerar o relatório. Tente novamente.",
    };
  }
}
