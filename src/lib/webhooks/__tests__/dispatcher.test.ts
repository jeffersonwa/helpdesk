/**
 * Testes do WebhookDispatcher (tarefa 29.2).
 *
 * Cobrem (Req. 17.2, 17.3, 17.4, 17.6):
 *  - assinatura HMAC + timestamp presentes nos headers de saída;
 *  - `signature === HMAC-SHA256(secret, body)` (recomputado com node:crypto);
 *  - sucesso APENAS com 2xx dentro de 10s (200 resolve; 500 lança; timeout lança);
 *  - o `secretRef`/valor do segredo NUNCA aparecem no payload, headers ou logs.
 *
 * Sem rede real: `fetch`, o resolvedor de segredo e o prisma são STUBADOS.
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebhookDispatchHandler,
  registerWebhookDispatch,
  signBody,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_DISPATCH_TYPE,
  type WebhookDispatcherPrisma,
} from "@/lib/webhooks/dispatcher";
import {
  createOutboxRegistry,
  type DueOutboxEvent,
} from "@/lib/outbox/worker";

const NOW = new Date("2026-06-03T12:00:00.000Z");
const SECRET = "super-secret-signing-key-value";
const SECRET_REF = "webhook:acme:sig";
const COMPANY_ID = "company-1";

/** Evento de outbox devido, com payload de `webhook.dispatch`. */
function seedEvent(
  payload: Record<string, unknown> = { event: "ticket.created", ticketId: "t-1" },
): DueOutboxEvent {
  return {
    id: "evt-1",
    companyId: COMPANY_ID,
    type: WEBHOOK_DISPATCH_TYPE,
    payload,
    attempts: 0,
  };
}

/** Prisma fake que devolve uma lista fixa de webhooks ativos. */
function makePrisma(
  webhooks: Array<{
    id: string;
    url: string;
    events: string[];
    secretRef: string;
  }>,
): { prisma: WebhookDispatcherPrisma; findMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn().mockResolvedValue(webhooks);
  const prisma = { webhook: { findMany } } as unknown as WebhookDispatcherPrisma;
  return { prisma, findMany };
}

const WEBHOOK = {
  id: "wh-1",
  url: "https://example.test/hook",
  events: ["ticket.created"],
  secretRef: SECRET_REF,
};

describe("WebhookDispatcher — assinatura HMAC e timestamp", () => {
  it("inclui X-Helpdesk-Signature (sha256=<hex>) e X-Helpdesk-Timestamp", async () => {
    const { prisma } = makePrisma([WEBHOOK]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const resolveSecret = vi.fn().mockResolvedValue(SECRET);

    const handler = createWebhookDispatchHandler({
      prisma,
      resolveSecret,
      fetch: fetchImpl,
      now: () => NOW,
    });

    const event = seedEvent();
    await handler(event.payload, event);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(WEBHOOK.url);
    const headers = init!.headers as Record<string, string>;
    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers[TIMESTAMP_HEADER]).toBe(NOW.toISOString());
  });

  it("signature === HMAC-SHA256(secret, body) recomputado independentemente", async () => {
    const { prisma } = makePrisma([WEBHOOK]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));

    const handler = createWebhookDispatchHandler({
      prisma,
      resolveSecret: () => SECRET,
      fetch: fetchImpl,
      now: () => NOW,
    });

    const event = seedEvent({ event: "ticket.created", ticketId: "t-9" });
    await handler(event.payload, event);

    const [, init] = fetchImpl.mock.calls[0];
    const sentBody = init!.body as string;
    const headers = init!.headers as Record<string, string>;

    // Recomputa o HMAC do corpo EXATO enviado.
    const expected = createHmac("sha256", SECRET)
      .update(sentBody, "utf8")
      .digest("hex");
    expect(headers[SIGNATURE_HEADER]).toBe(`sha256=${expected}`);
    // E confere com o helper exportado.
    expect(signBody(SECRET, sentBody)).toBe(expected);
  });

  it("carrega apenas webhooks ativos do tenant assinantes do evento", async () => {
    const { prisma, findMany } = makePrisma([WEBHOOK]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));

    const handler = createWebhookDispatchHandler({
      prisma,
      resolveSecret: () => SECRET,
      fetch: fetchImpl,
      now: () => NOW,
    });

    const event = seedEvent();
    await handler(event.payload, event);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: COMPANY_ID,
          active: true,
          events: { has: "ticket.created" },
        }),
      }),
    );
  });
});

describe("WebhookDispatcher — sucesso somente com 2xx em ≤10s", () => {
  it("200 → resolve (entrega bem-sucedida)", async () => {
    const { prisma } = makePrisma([WEBHOOK]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const handler = createWebhookDispatchHandler({
      prisma,
      resolveSecret: () => SECRET,
      fetch: fetchImpl,
      now: () => NOW,
    });

    const event = seedEvent();
    await expect(handler(event.payload, event)).resolves.toBeUndefined();
  });

  it("500 → lança (falha de entrega)", async () => {
    const { prisma } = makePrisma([WEBHOOK]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("boom", { status: 500 }));

    const handler = createWebhookDispatchHandler({
      prisma,
      resolveSecret: () => SECRET,
      fetch: fetchImpl,
      now: () => NOW,
    });

    const event = seedEvent();
    await expect(handler(event.payload, event)).rejects.toThrow();
  });

  it("timeout (fetch abortado) → lança (falha de entrega)", async () => {
    vi.useFakeTimers();
    try {
      const { prisma } = makePrisma([WEBHOOK]);
      // fetch que só rejeita quando o AbortSignal dispara (simula timeout).
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation((_url, init) => {
          return new Promise((_resolve, reject) => {
            const signal = (init as RequestInit).signal as AbortSignal;
            signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        });

      const handler = createWebhookDispatchHandler({
        prisma,
        resolveSecret: () => SECRET,
        fetch: fetchImpl,
        now: () => NOW,
        timeoutMs: 10_000,
      });

      const event = seedEvent();
      const promise = handler(event.payload, event);
      // Assertion antes de avançar o relógio evita unhandled rejection.
      const expectation = expect(promise).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("sem assinantes → no-op (não chama fetch, resolve)", async () => {
    const { prisma } = makePrisma([]);
    const fetchImpl = vi.fn<typeof fetch>();

    const handler = createWebhookDispatchHandler({
      prisma,
      resolveSecret: () => SECRET,
      fetch: fetchImpl,
      now: () => NOW,
    });

    const event = seedEvent();
    await expect(handler(event.payload, event)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("WebhookDispatcher — o segredo nunca vaza", () => {
  it("o valor do segredo e o secretRef não aparecem em body/headers/logs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { prisma } = makePrisma([WEBHOOK]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));

    const handler = createWebhookDispatchHandler({
      prisma,
      resolveSecret: () => SECRET,
      fetch: fetchImpl,
      now: () => NOW,
    });

    const event = seedEvent();
    await handler(event.payload, event);

    const [, init] = fetchImpl.mock.calls[0];
    const sentBody = init!.body as string;
    const headersSerialized = JSON.stringify(init!.headers);

    // Nem o valor do segredo nem o secretRef vão no corpo ou nos headers.
    expect(sentBody).not.toContain(SECRET);
    expect(sentBody).not.toContain(SECRET_REF);
    expect(headersSerialized).not.toContain(SECRET);
    expect(headersSerialized).not.toContain(SECRET_REF);

    // Nem em nenhum log emitido.
    const allLogs = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    expect(allLogs).not.toContain(SECRET);
    expect(allLogs).not.toContain(SECRET_REF);

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("a mensagem de erro em falha não contém o segredo", async () => {
    const { prisma } = makePrisma([WEBHOOK]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 500 }));

    const handler = createWebhookDispatchHandler({
      prisma,
      resolveSecret: () => SECRET,
      fetch: fetchImpl,
      now: () => NOW,
    });

    const event = seedEvent();
    await handler(event.payload, event).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(SECRET_REF);
    });
  });
});

describe("registerWebhookDispatch — wiring no registry do outbox", () => {
  it("registra o handler sob o type webhook.dispatch", async () => {
    const registry = createOutboxRegistry();
    const { prisma } = makePrisma([WEBHOOK]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));

    registerWebhookDispatch(
      { prisma, resolveSecret: () => SECRET, fetch: fetchImpl, now: () => NOW },
      registry,
    );

    const handler = registry.get(WEBHOOK_DISPATCH_TYPE);
    expect(handler).toBeTypeOf("function");

    const event = seedEvent();
    await handler!(event.payload, event);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
