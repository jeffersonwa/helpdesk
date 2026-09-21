/**
 * Outbox worker — processamento idempotente de `OutboxEvent` (tarefa 23.1).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (tabela de tratamento de erros — "Retry/backoff do outbox") e requirements
 * 17.4, 17.5, 17.6.
 *
 * ## Estratégia de claim/lock (idempotência)
 * Antes de executar um handler, o worker RECLAMA o evento com um `updateMany`
 * condicional: `where { id, state: PENDING } → set state = PROCESSING`. O contador
 * de linhas afetadas (`count`) é a trava:
 *   - `count === 1`: este worker ganhou o claim e é o único a processar.
 *   - `count === 0`: outro worker já reclamou (ou o evento já saiu de PENDING);
 *     ignoramos o evento (evita processamento duplo mesmo com múltiplos workers
 *     concorrentes). Um evento já `SENT`/`FAILED` nunca é reclamado.
 *
 * ## Resultado do handler
 *   - sucesso → `state = SENT`.
 *   - falha   → `attempts += 1`; se `attempts < MAX_ATTEMPTS` (5) volta a
 *     `PENDING` com `nextRunAt = now + backoff(attempts)`; caso contrário
 *     `state = FAILED` (definitivo) e um alerta é emitido (Req. 17.5, 17.6).
 *
 * ## Backoff exponencial (Req. 17.5)
 * Inicia em 60s e dobra a cada tentativa, limitado a 3600s:
 *   attempts=1 → 60s, 2 → 120s, 3 → 240s, 4 → 480s, ... , cap em 3600s.
 * Após 5 tentativas o evento é `FAILED` (não é reagendado).
 *
 * Todas as dependências (prisma, relógio `now`, `alert`) são injetáveis para
 * teste determinístico. O worker NÃO conhece os efeitos concretos: eles são
 * registrados como handlers por `type` num registry.
 *
 * _Requisitos: 17.1, 17.4, 17.5, 17.6_
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { OutboxState } from "@/lib/domain/enums";
import { prisma as defaultPrisma } from "@/lib/prisma";

/** Número máximo de tentativas antes de marcar `FAILED` (Req. 17.6). */
export const MAX_ATTEMPTS = 5;

/** Backoff base (60s) e teto (3600s) em milissegundos (Req. 17.5). */
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 3_600_000;

/** Tamanho padrão do lote de eventos processados por chamada. */
const DEFAULT_BATCH_SIZE = 50;

/**
 * Calcula o backoff (em ms) para a tentativa `attempts` (1-based):
 * `min(60s * 2^(attempts-1), 3600s)`.
 *
 * attempts=1 → 60_000; =2 → 120_000; =3 → 240_000; =6 → 1_920_000; grandes → cap.
 * Exportada para os testes verificarem a progressão e o teto.
 */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return BASE_BACKOFF_MS;
  // 2^(attempts-1) pode estourar para valores grandes; o cap resolve.
  const factor = Math.pow(2, attempts - 1);
  const raw = BASE_BACKOFF_MS * factor;
  if (!Number.isFinite(raw) || raw > MAX_BACKOFF_MS) return MAX_BACKOFF_MS;
  return raw;
}

/** Payload entregue ao handler (JSON persistido em `OutboxEvent.payload`). */
export type OutboxPayload = Prisma.JsonValue;

/** Um handler de outbox: executa o efeito externo para um `type`. */
export type OutboxHandler = (
  payload: OutboxPayload,
  event: DueOutboxEvent,
) => Promise<void>;

/** Função de alerta chamada quando um evento é marcado `FAILED` (Req. 17.6). */
export type OutboxAlert = (event: DueOutboxEvent, error: unknown) => void;

/** Forma mínima de um evento devido, lida pelo worker. */
export interface DueOutboxEvent {
  id: string;
  companyId: string;
  type: string;
  payload: OutboxPayload;
  attempts: number;
}

/** Registry de handlers indexado por `type`. */
export type OutboxRegistry = Map<string, OutboxHandler>;

/** Cria um registry vazio. */
export function createOutboxRegistry(): OutboxRegistry {
  return new Map();
}

/** Registry global padrão (usado pelo entrypoint do worker). */
const defaultRegistry: OutboxRegistry = createOutboxRegistry();

/** Registra (ou substitui) o handler de um `type` no registry informado. */
export function registerOutboxHandler(
  type: string,
  handler: OutboxHandler,
  registry: OutboxRegistry = defaultRegistry,
): void {
  registry.set(type, handler);
}

/** Client Prisma mínimo do qual o worker depende (facilita mock/injeção). */
export type WorkerPrisma = Pick<PrismaClient, "outboxEvent">;

/** Dependências injetáveis de {@link processOutboxOnce}. */
export interface ProcessOutboxDeps {
  prisma?: WorkerPrisma;
  registry?: OutboxRegistry;
  now?: () => Date;
  /** Tamanho máximo do lote de eventos devidos processados por chamada. */
  batchSize?: number;
  /** Alerta emitido em falha definitiva (default: `console.error`). */
  alert?: OutboxAlert;
}

/** Resumo do processamento de um lote. */
export interface ProcessOutboxResult {
  claimed: number;
  sent: number;
  rescheduled: number;
  failed: number;
  /** Eventos devidos ignorados por não terem handler registrado. */
  skippedNoHandler: number;
}

/**
 * Processa um único lote de eventos devidos do outbox.
 *
 * Passos:
 *  1. Busca eventos `PENDING` com `nextRunAt <= now`, ordenados por `nextRunAt`
 *     (mais antigos primeiro), limitados a `batchSize`.
 *  2. Para cada evento: tenta reclamar (`PENDING → PROCESSING`, condicional).
 *     Se o claim falhar (outro worker), pula.
 *  3. Resolve o handler por `type`. Sem handler → devolve o evento a `PENDING`
 *     com backoff (mantém para reprocessar quando o handler existir) e conta como
 *     `skippedNoHandler`. Isso evita perder o evento por configuração incompleta.
 *  4. Executa o handler; sucesso → `SENT`; falha → incrementa `attempts` e
 *     reagenda com backoff ou marca `FAILED` + alerta.
 *
 * É seguro chamar repetidamente (idempotente): eventos `SENT`/`FAILED` não são
 * relidos e o claim impede processamento duplo.
 */
export async function processOutboxOnce(
  deps: ProcessOutboxDeps = {},
): Promise<ProcessOutboxResult> {
  const prisma = deps.prisma ?? (defaultPrisma as unknown as WorkerPrisma);
  const registry = deps.registry ?? defaultRegistry;
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const alert: OutboxAlert =
    deps.alert ??
    ((event, error) => {
      // Alerta padrão: log de erro sem PII/segredos (apenas ids técnicos).
      console.error(
        `[outbox] evento FAILED id=${event.id} type=${event.type} attempts=${event.attempts + 1}`,
        error instanceof Error ? error.message : String(error),
      );
    });

  const result: ProcessOutboxResult = {
    claimed: 0,
    sent: 0,
    rescheduled: 0,
    failed: 0,
    skippedNoHandler: 0,
  };

  const currentNow = now();

  const due = (await prisma.outboxEvent.findMany({
    where: { state: OutboxState.PENDING, nextRunAt: { lte: currentNow } },
    orderBy: { nextRunAt: "asc" },
    take: batchSize,
    select: {
      id: true,
      companyId: true,
      type: true,
      payload: true,
      attempts: true,
    },
  })) as DueOutboxEvent[];

  for (const event of due) {
    // (2) Claim condicional: só um worker vence a corrida por evento.
    const claim = await prisma.outboxEvent.updateMany({
      where: { id: event.id, state: OutboxState.PENDING },
      data: { state: OutboxState.PROCESSING },
    });
    if (claim.count !== 1) {
      // Outro worker reclamou (ou o evento saiu de PENDING). Ignora.
      continue;
    }
    result.claimed += 1;

    const handler = registry.get(event.type);
    if (!handler) {
      // (3) Sem handler: não é uma falha de entrega; devolve a PENDING com um
      // backoff para tentar novamente quando o handler for registrado. NÃO
      // incrementa `attempts` (não é uma tentativa de entrega real).
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          state: OutboxState.PENDING,
          nextRunAt: new Date(currentNow.getTime() + backoffMs(1)),
        },
      });
      result.skippedNoHandler += 1;
      continue;
    }

    try {
      await handler(event.payload, event);
      // (4a) Sucesso → SENT.
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { state: OutboxState.SENT },
      });
      result.sent += 1;
    } catch (error) {
      // (4b) Falha → incrementa attempts e decide reagendar ou FAILED.
      const attempts = event.attempts + 1;
      if (attempts < MAX_ATTEMPTS) {
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            state: OutboxState.PENDING,
            attempts,
            nextRunAt: new Date(currentNow.getTime() + backoffMs(attempts)),
          },
        });
        result.rescheduled += 1;
      } else {
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { state: OutboxState.FAILED, attempts },
        });
        result.failed += 1;
        alert(event, error);
      }
    }
  }

  return result;
}

/** Reexport do registry padrão para o entrypoint do worker. */
export { defaultRegistry };
