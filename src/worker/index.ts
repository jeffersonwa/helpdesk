/**
 * Worker entrypoint — processo separado do `app` (tarefa 23.1).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Implantação" — `worker: outbox + escalonamento` como serviço/Deployment
 * separado) e requirements 17.4, 12.4.
 *
 * Responsabilidades:
 *  - Dispara periodicamente o processamento do outbox (`processOutboxOnce`).
 *  - Dispara periodicamente a varredura de escalonamento (`runEscalationSweepOnce`,
 *    intervalo ≤5 min — Req. 12.4).
 *
 * IMPORTANTE (segurança de importação em testes): este módulo NÃO abre conexões
 * nem inicia laços/timers apenas por ser importado. O laço só arranca quando o
 * arquivo é executado DIRETAMENTE como processo principal (checagem
 * `isMainModule()`). Assim o Vitest pode importar/coletar sem efeitos colaterais.
 *
 * _Requisitos: 17.1, 17.4, 17.5, 17.6, 12.4_
 */

import { pathToFileURL } from "node:url";
import { processOutboxOnce } from "@/lib/outbox/worker";
import { runEscalationSweepOnce } from "@/worker/escalation";

/** Intervalo de processamento do outbox (ms). Ajustável por env. */
const OUTBOX_INTERVAL_MS = Number(
  process.env.OUTBOX_INTERVAL_MS ?? 5_000,
);

/**
 * Intervalo de varredura de escalonamento (ms). Deve ser ≤5 min (Req. 12.4);
 * default de 60s. Nunca ultrapassa o limite de 5 min.
 */
const ESCALATION_INTERVAL_MS = Math.min(
  Number(process.env.ESCALATION_INTERVAL_MS ?? 60_000),
  5 * 60_000,
);

/** Executa uma iteração do outbox, sem deixar erros derrubarem o laço. */
export async function tickOutbox(): Promise<void> {
  try {
    await processOutboxOnce();
  } catch (error) {
    console.error(
      "[worker] falha ao processar outbox:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Executa uma varredura de escalonamento, isolando erros do laço. */
export async function tickEscalation(): Promise<void> {
  try {
    await runEscalationSweepOnce();
  } catch (error) {
    console.error(
      "[worker] falha na varredura de escalonamento:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Handle dos timers ativos, para permitir parada limpa (`stop()`). */
export interface WorkerHandles {
  outboxTimer: NodeJS.Timeout;
  escalationTimer: NodeJS.Timeout;
  stop: () => void;
}

/**
 * Inicia os laços de processamento. Só deve ser chamado pelo processo principal
 * (não em import). Cada laço é agendado com `setInterval`; erros de cada iteração
 * são capturados dentro dos ticks para não derrubar o timer.
 */
export function startWorker(): WorkerHandles {
  console.log(
    `[worker] iniciando — outbox a cada ${OUTBOX_INTERVAL_MS}ms, escalonamento a cada ${ESCALATION_INTERVAL_MS}ms`,
  );

  const outboxTimer = setInterval(() => {
    void tickOutbox();
  }, OUTBOX_INTERVAL_MS);

  const escalationTimer = setInterval(() => {
    void tickEscalation();
  }, ESCALATION_INTERVAL_MS);

  const stop = () => {
    clearInterval(outboxTimer);
    clearInterval(escalationTimer);
  };

  return { outboxTimer, escalationTimer, stop };
}

/**
 * Detecta se este arquivo é o módulo principal (executado como
 * `node .../worker/index.js`), e não apenas importado. Comparamos a URL do
 * módulo com a URL derivada de `process.argv[1]`.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

// Só arranca o laço quando executado diretamente — importar é sempre seguro.
if (isMainModule()) {
  const handles = startWorker();
  const shutdown = () => {
    console.log("[worker] encerrando…");
    handles.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
