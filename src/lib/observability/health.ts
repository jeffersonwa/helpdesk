/**
 * Health check — núcleo PURO e injetável (tarefa 30.2).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Observabilidade") e requirements 19.3, 19.4.
 *
 * ------------------------------------------------------------------------
 * CONTRATO (Req. 19.3, 19.4)
 * ------------------------------------------------------------------------
 * `/api/health` reporta, em ≤2s, o estado por dependência: `app`, `db`, `queue`.
 * - `app`   → sempre `ok` (o processo está respondendo).
 * - `db`    → via probe INJETADO (ex.: `SELECT 1`), com timeout.
 * - `queue` → via probe INJETADO (ex.: backlog/ping do outbox), com timeout.
 *
 * Se uma dependência CRÍTICA (`db` ou `queue`) estiver indisponível, o estado
 * geral é `unhealthy` e a rota responde HTTP 503; caso contrário, 200.
 *
 * O NÚCLEO é `computeHealth(deps)`: uma função assíncrona pura sobre probes
 * injetados. Ela NÃO conhece Prisma, HTTP ou o runtime do Next — a rota faz o
 * wiring. Cada probe é envolvido por um timeout: um probe lento resolve como
 * `unhealthy` (não trava o health check).
 */

/** Estado de uma dependência individual. */
export type CheckStatus = "ok" | "unhealthy";

/** Estado geral agregado. */
export type OverallStatus = "healthy" | "degraded" | "unhealthy";

/** Nomes das dependências reportadas. */
export type DependencyName = "app" | "db" | "queue";

/** Resultado por dependência. */
export interface DependencyCheck {
  status: CheckStatus;
  /** Latência observada, em ms (quando medida). */
  latencyMs?: number;
  /** Detalhe curto, livre de segredos/PII (ex.: "timeout"). */
  detail?: string;
}

/** Resultado agregado do health check. */
export interface HealthReport {
  status: OverallStatus;
  checks: Record<DependencyName, DependencyCheck>;
}

/**
 * Um probe de dependência: resolve `true`/`{ok:true}` quando saudável. Aqui
 * usamos uma função que resolve com `void` em sucesso e REJEITA/lança em falha,
 * OU resolve `false` para indicar indisponibilidade — ambos tratados como
 * `unhealthy`.
 */
export type Probe = () => Promise<boolean | void>;

/** Timeout padrão por probe, em ms (mantém o total ≤2s — Req. 19.3). */
export const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

/** Dependências injetáveis de {@link computeHealth}. */
export interface ComputeHealthDeps {
  /** Probe do banco (ex.: `SELECT 1`). Crítico. */
  dbProbe: Probe;
  /** Probe da fila/outbox (ex.: backlog/ping). Crítico. */
  queueProbe: Probe;
  /** Timeout por probe, em ms (default {@link DEFAULT_PROBE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Relógio para medir latência (default: `Date.now` via `performance`? usa Date). */
  now?: () => number;
}

/** Sentinela interna para diferenciar timeout de outras rejeições. */
const TIMEOUT = Symbol("probe-timeout");

/**
 * Executa um probe com timeout e mede a latência. Nunca lança: converte
 * qualquer falha/timeout/`false` em um {@link DependencyCheck} `unhealthy`.
 */
async function runProbe(
  probe: Probe,
  timeoutMs: number,
  now: () => number,
): Promise<DependencyCheck> {
  const start = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    const outcome = await Promise.race([probe(), timeout]);
    const latencyMs = now() - start;

    if (outcome === TIMEOUT) {
      return { status: "unhealthy", latencyMs, detail: "timeout" };
    }
    // `false` explícito → indisponível; `void`/`true` → ok.
    if (outcome === false) {
      return { status: "unhealthy", latencyMs, detail: "unavailable" };
    }
    return { status: "ok", latencyMs };
  } catch {
    // Erro do probe (ex.: conexão recusada). Sem detalhes sensíveis.
    return { status: "unhealthy", latencyMs: now() - start, detail: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Calcula o health report a partir dos probes injetados (NÚCLEO PURO).
 *
 * - `app` é sempre `ok`.
 * - `db` e `queue` são probados em PARALELO, cada um com seu timeout.
 * - Agregação: se `db` OU `queue` estiver `unhealthy` → geral `unhealthy`
 *   (dependência crítica indisponível → 503 na rota). Se todos `ok` →
 *   `healthy`. `degraded` fica reservado para dependências NÃO críticas
 *   (nenhuma no momento), mantido no tipo para evolução.
 */
export async function computeHealth(
  deps: ComputeHealthDeps,
): Promise<HealthReport> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());

  const [db, queue] = await Promise.all([
    runProbe(deps.dbProbe, timeoutMs, now),
    runProbe(deps.queueProbe, timeoutMs, now),
  ]);

  const app: DependencyCheck = { status: "ok" };

  const criticalDown = db.status === "unhealthy" || queue.status === "unhealthy";
  const status: OverallStatus = criticalDown ? "unhealthy" : "healthy";

  return { status, checks: { app, db, queue } };
}

/** Mapeia o estado geral para o status HTTP da rota (Req. 19.4). */
export function healthHttpStatus(status: OverallStatus): 200 | 503 {
  return status === "unhealthy" ? 503 : 200;
}
