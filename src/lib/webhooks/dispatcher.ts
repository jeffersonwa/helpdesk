/**
 * WebhookDispatcher — disparo de webhooks de saída assinados por HMAC (tarefa 29.1).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seções "Outbox transacional", "Observabilidade" e tabela de tratamento de
 * erros — "Retry/backoff do outbox") e requirements 17.1–17.6.
 *
 * ------------------------------------------------------------------------
 * PAPEL
 * ------------------------------------------------------------------------
 * Este módulo NÃO enfileira nem processa a fila diretamente — ele fornece o
 * HANDLER do outbox para o `type = "webhook.dispatch"`. O worker idempotente da
 * tarefa 23 (`processOutboxOnce`) reclama o evento, chama este handler e, com
 * base no resultado (sucesso vs. exceção), marca `SENT` ou incrementa
 * `attempts`/reagenda com backoff / marca `FAILED` após 5 tentativas.
 *
 * Portanto, o CONTRATO com o worker é simples e deliberado (Req. 17.4–17.6):
 *   - retorno normal  → entrega bem-sucedida (o worker marca `SENT`);
 *   - `throw`         → falha de entrega (o worker aplica backoff/FAILED).
 *
 * ------------------------------------------------------------------------
 * ASSINATURA HMAC (Req. 17.2, 17.3)
 * ------------------------------------------------------------------------
 * Cada POST é assinado com HMAC-SHA256 sobre o CORPO EXATO enviado (o mesmo
 * texto serializado). O segredo NUNCA é armazenado nem logado: ele é resolvido
 * em runtime a partir de `Webhook.secretRef` por um resolvedor INJETADO
 * (`SecretResolver`). O valor do segredo existe apenas em memória durante o
 * cálculo do HMAC e nunca entra no payload, nos headers (só o digest hex vai) ou
 * em qualquer log.
 *
 * Headers de assinatura:
 *   - `X-Helpdesk-Signature: sha256=<hex>`  (HMAC-SHA256 hex do corpo)
 *   - `X-Helpdesk-Timestamp: <ISO-8601>`    (instante da geração)
 *
 * ------------------------------------------------------------------------
 * SUCESSO x FALHA (Req. 17.4)
 * ------------------------------------------------------------------------
 * A entrega só é bem-sucedida se o endpoint responder com status 2xx DENTRO de
 * 10 segundos. Um `AbortController` cancela a requisição no timeout. Timeout,
 * erro de rede ou status não-2xx → `throw` (falha), delegando retry/backoff ao
 * worker.
 *
 * _Requisitos: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_
 */

import { createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import {
  registerOutboxHandler,
  type OutboxHandler,
  type OutboxRegistry,
} from "@/lib/outbox/worker";

/** Tipo do evento de outbox tratado por este handler. */
export const WEBHOOK_DISPATCH_TYPE = "webhook.dispatch" as const;

/** Header da assinatura HMAC (formato `sha256=<hex>`). */
export const SIGNATURE_HEADER = "X-Helpdesk-Signature" as const;

/** Header do timestamp de geração (ISO-8601). */
export const TIMESTAMP_HEADER = "X-Helpdesk-Timestamp" as const;

/** Janela máxima de entrega bem-sucedida, em ms (Req. 17.4). */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Payload do evento `webhook.dispatch` no outbox. Carrega o nome do evento de
 * negócio (`event`, ex.: `"ticket.created"`) e quaisquer dados adicionais que
 * comporão o corpo entregue aos endpoints assinantes. NUNCA contém segredos.
 */
export interface WebhookDispatchPayload {
  /** Nome do evento de negócio (ex.: "ticket.created", "ticket.resolved"). */
  event: string;
  /** Dados adicionais serializados no corpo do webhook. */
  [key: string]: unknown;
}

/**
 * Resolvedor de segredo por `secretRef` (INJETADO). Recebe a referência opaca
 * (`Webhook.secretRef`) e devolve o valor do segredo de assinatura. Deve
 * consultar env/secret manager — nunca é implementado aqui para não acoplar o
 * dispatcher a uma origem de segredo. Lançar/rejeitar quando o `secretRef` não
 * resolve; o dispatcher trata isso como falha de entrega do webhook em questão.
 */
export type SecretResolver = (secretRef: string) => Promise<string> | string;

/** Prisma mínimo do qual o handler depende (lista de webhooks ativos). */
export type WebhookDispatcherPrisma = Pick<PrismaClient, "webhook">;

/** Dependências injetáveis do handler `webhook.dispatch`. */
export interface WebhookDispatcherDeps {
  /** Prisma para carregar os `Webhook` ativos do tenant. */
  prisma: WebhookDispatcherPrisma;
  /** Resolve `Webhook.secretRef` → valor do segredo (nunca armazenado/logado). */
  resolveSecret: SecretResolver;
  /** `fetch` nativo (injetável para testes; nunca faz rede real em teste). */
  fetch?: typeof fetch;
  /** Relógio injetável (timestamp do header e determinismo em teste). */
  now?: () => Date;
  /** Janela de entrega, em ms (default {@link DELIVERY_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** Forma mínima de um `Webhook` ativo carregado do banco. */
interface ActiveWebhook {
  id: string;
  url: string;
  events: string[];
  secretRef: string;
}

/**
 * Calcula a assinatura HMAC-SHA256 (hex) do corpo com o segredo resolvido.
 * O segredo é usado APENAS aqui e não escapa deste escopo.
 */
export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Entrega um único webhook: assina o corpo, POSTa com timeout de 10s e valida a
 * resposta. Lança em timeout/rede/não-2xx (o chamador agrega falhas por evento).
 *
 * O segredo é resolvido logo antes do uso e não é retido: se `resolveSecret`
 * falhar, a exceção propaga como falha de entrega daquele webhook.
 */
async function deliverOne(
  webhook: ActiveWebhook,
  body: string,
  deps: Required<Pick<WebhookDispatcherDeps, "resolveSecret" | "fetch" | "now">>,
  timeoutMs: number,
): Promise<void> {
  const secret = await deps.resolveSecret(webhook.secretRef);
  const signature = signBody(secret, body);
  const timestamp = deps.now().toISOString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: `sha256=${signature}`,
        [TIMESTAMP_HEADER]: timestamp,
      },
      body,
      signal: controller.signal,
    });
    // Sucesso somente com 2xx (Req. 17.4). Qualquer outro status → falha.
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `webhook ${webhook.id} respondeu status ${res.status} (não-2xx)`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Constrói o handler de outbox para `webhook.dispatch`.
 *
 * Fluxo (Req. 17.2–17.4):
 *  1. Carrega os `Webhook` ativos do tenant do evento cujo array `events`
 *     contém o `event` do payload (assinantes daquele evento).
 *  2. Serializa o payload UMA vez (o mesmo texto é assinado e enviado).
 *  3. Entrega a cada assinante, assinando com HMAC e respeitando o timeout.
 *  4. Se QUALQUER entrega falhar, lança — o worker então reagenda o evento
 *     inteiro (backoff) até `SENT` ou `FAILED` (Req. 17.5, 17.6). Sem
 *     assinantes → no-op (SENT), pois não há nada a entregar.
 */
export function createWebhookDispatchHandler(
  deps: WebhookDispatcherDeps,
): OutboxHandler {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? DELIVERY_TIMEOUT_MS;

  return async (payload, event): Promise<void> => {
    const data = (payload ?? {}) as WebhookDispatchPayload;
    const eventName = typeof data.event === "string" ? data.event : "";

    const webhooks = (await deps.prisma.webhook.findMany({
      where: {
        companyId: event.companyId,
        active: true,
        events: { has: eventName },
      },
      select: { id: true, url: true, events: true, secretRef: true },
    })) as ActiveWebhook[];

    if (webhooks.length === 0) {
      // Nenhum assinante ativo para este evento: nada a entregar (SENT).
      return;
    }

    const body = JSON.stringify(data);

    const results = await Promise.allSettled(
      webhooks.map((webhook) =>
        deliverOne(
          webhook,
          body,
          { resolveSecret: deps.resolveSecret, fetch: fetchImpl, now },
          timeoutMs,
        ),
      ),
    );

    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failures.length > 0) {
      // Ao menos uma entrega falhou: propaga para o worker aplicar backoff/FAILED.
      // A mensagem cita apenas ids técnicos e contagem — nunca segredos/corpo.
      throw new Error(
        `webhook.dispatch: ${failures.length}/${webhooks.length} entrega(s) falharam para o evento "${eventName}"`,
      );
    }
  };
}

/**
 * Registra o handler `webhook.dispatch` no registry do outbox, montado com as
 * dependências fornecidas (prisma + resolvedor de segredo + fetch + relógio).
 *
 * Chame isto no bootstrap do worker. Em produção, injete o `prisma`
 * compartilhado e um `resolveSecret` que consulte o secret store por
 * `secretRef` (nunca embuta o valor no código).
 */
export function registerWebhookDispatch(
  deps: Partial<WebhookDispatcherDeps> & { resolveSecret: SecretResolver },
  registry?: OutboxRegistry,
): void {
  const resolved: WebhookDispatcherDeps = {
    prisma:
      deps.prisma ?? (defaultPrisma as unknown as WebhookDispatcherPrisma),
    resolveSecret: deps.resolveSecret,
    fetch: deps.fetch ?? globalThis.fetch,
    now: deps.now ?? (() => new Date()),
    timeoutMs: deps.timeoutMs ?? DELIVERY_TIMEOUT_MS,
  };
  registerOutboxHandler(
    WEBHOOK_DISPATCH_TYPE,
    createWebhookDispatchHandler(resolved),
    registry,
  );
}
