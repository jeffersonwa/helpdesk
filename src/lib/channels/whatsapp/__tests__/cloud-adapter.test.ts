/**
 * Testes do `WhatsAppCloudAdapter`:
 *  - verificação de webhook: GET handshake (verify_token) e POST HMAC
 *    (`X-Hub-Signature-256`) com comparação em tempo constante;
 *  - Property 11 (não vazamento de segredos): espionar console/logs e garantir
 *    que nenhum valor de segredo (appSecret/verifyToken/accessToken) apareça —
 *    apenas `secretRef`.
 *
 * Valida: Req 6.3, 6.4, 6.5, 6.6, 17.3, 19.2.
 *
 * Todo `fetch` é STUBADO — nenhuma chamada de rede real.
 */

import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAccountRef, RawRequest } from "@/lib/channels/adapter";
import {
  WHATSAPP_CLOUD_HOST,
  createWhatsAppCloudAdapter,
  type WhatsAppSecrets,
} from "@/lib/channels/whatsapp/cloud-adapter";
import {
  ChannelProvider,
  ChannelType,
  MessageType,
} from "@/lib/domain";

const SECRETS: WhatsAppSecrets = {
  appSecret: "SUPER_SECRET_APP_SECRET",
  verifyToken: "SUPER_SECRET_VERIFY_TOKEN",
  accessToken: "SUPER_SECRET_ACCESS_TOKEN",
  phoneNumberId: "555000111",
};

const SECRET_REF = "secret://whatsapp/acc-1";

const ACCOUNT: ChannelAccountRef = {
  id: "acc-1",
  companyId: "company-1",
  type: ChannelType.WHATSAPP,
  provider: ChannelProvider.WHATSAPP_CLOUD,
  externalId: "555000111",
  secretRef: SECRET_REF,
};

function makeAdapter(fetchImpl?: typeof fetch) {
  return createWhatsAppCloudAdapter({
    resolveSecrets: async (ref) => {
      if (ref !== SECRET_REF) {
        throw new Error("unknown secretRef");
      }
      return SECRETS;
    },
    resolveAccount: async () => ({ id: "acc-1", companyId: "company-1" }),
    resolveWindow: async () => new Date(Date.now() + 60 * 60 * 1000),
    fetchImpl:
      fetchImpl ??
      ((async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch),
  });
}

describe("WhatsAppCloudAdapter.verifyInbound — GET handshake (Req 6.3, 6.4)", () => {
  it("retorna true quando hub.mode=subscribe e verify_token confere", async () => {
    const adapter = makeAdapter();
    const req: RawRequest = {
      method: "GET",
      headers: {},
      query: {
        __secretRef: SECRET_REF,
        "hub.mode": "subscribe",
        "hub.verify_token": SECRETS.verifyToken,
        "hub.challenge": "12345",
      },
      rawBody: "",
    };
    expect(await adapter.verifyInbound(req)).toBe(true);
  });

  it("retorna false quando verify_token diverge", async () => {
    const adapter = makeAdapter();
    const req: RawRequest = {
      method: "GET",
      headers: {},
      query: {
        __secretRef: SECRET_REF,
        "hub.mode": "subscribe",
        "hub.verify_token": "TOKEN_ERRADO",
        "hub.challenge": "12345",
      },
      rawBody: "",
    };
    expect(await adapter.verifyInbound(req)).toBe(false);
  });

  it("retorna false quando hub.mode não é subscribe", async () => {
    const adapter = makeAdapter();
    const req: RawRequest = {
      method: "GET",
      headers: {},
      query: {
        __secretRef: SECRET_REF,
        "hub.mode": "unsubscribe",
        "hub.verify_token": SECRETS.verifyToken,
      },
      rawBody: "",
    };
    expect(await adapter.verifyInbound(req)).toBe(false);
  });
});

describe("WhatsAppCloudAdapter.verifyInbound — POST HMAC (Req 6.5, 6.6)", () => {
  const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  function signature(body: string, secret: string): string {
    return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  }

  it("retorna true para assinatura HMAC válida", async () => {
    const adapter = makeAdapter();
    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": signature(rawBody, SECRETS.appSecret) },
      query: { __secretRef: SECRET_REF },
      rawBody,
    };
    expect(await adapter.verifyInbound(req)).toBe(true);
  });

  it("retorna false para assinatura inválida (secret errado)", async () => {
    const adapter = makeAdapter();
    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": signature(rawBody, "SECRET_ERRADO") },
      query: { __secretRef: SECRET_REF },
      rawBody,
    };
    expect(await adapter.verifyInbound(req)).toBe(false);
  });

  it("retorna false quando o header X-Hub-Signature-256 está ausente", async () => {
    const adapter = makeAdapter();
    const req: RawRequest = {
      method: "POST",
      headers: {},
      query: { __secretRef: SECRET_REF },
      rawBody,
    };
    expect(await adapter.verifyInbound(req)).toBe(false);
  });

  it("retorna false quando o body foi adulterado (assinatura não confere)", async () => {
    const adapter = makeAdapter();
    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": signature(rawBody, SECRETS.appSecret) },
      query: { __secretRef: SECRET_REF },
      rawBody: rawBody + "TAMPERED",
    };
    expect(await adapter.verifyInbound(req)).toBe(false);
  });

  it("retorna false quando falta a secretRef", async () => {
    const adapter = makeAdapter();
    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": signature(rawBody, SECRETS.appSecret) },
      query: {},
      rawBody,
    };
    expect(await adapter.verifyInbound(req)).toBe(false);
  });
});

describe("Property 11 — nenhum segredo aparece em logs/telemetria (Req 6.3-6.6, 17.3, 19.2)", () => {
  let logSpies: Array<ReturnType<typeof vi.spyOn>>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    const record = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    logSpies = [
      vi.spyOn(console, "log").mockImplementation(record),
      vi.spyOn(console, "info").mockImplementation(record),
      vi.spyOn(console, "warn").mockImplementation(record),
      vi.spyOn(console, "error").mockImplementation(record),
      vi.spyOn(console, "debug").mockImplementation(record),
    ];
  });

  afterEach(() => {
    for (const spy of logSpies) {
      spy.mockRestore();
    }
  });

  function assertNoSecretLeak() {
    const all = captured.join("\n");
    expect(all).not.toContain(SECRETS.appSecret);
    expect(all).not.toContain(SECRETS.verifyToken);
    expect(all).not.toContain(SECRETS.accessToken);
  }

  it("verifyInbound (GET/POST) não vaza segredos", async () => {
    const adapter = makeAdapter();
    const rawBody = JSON.stringify({ entry: [] });
    await adapter.verifyInbound({
      method: "GET",
      headers: {},
      query: {
        __secretRef: SECRET_REF,
        "hub.mode": "subscribe",
        "hub.verify_token": SECRETS.verifyToken,
      },
      rawBody: "",
    });
    await adapter.verifyInbound({
      method: "POST",
      headers: {
        "x-hub-signature-256":
          "sha256=" + createHmac("sha256", SECRETS.appSecret).update(rawBody, "utf8").digest("hex"),
      },
      query: { __secretRef: SECRET_REF },
      rawBody,
    });
    assertNoSecretLeak();
  });

  it("send() com erro HTTP não vaza accessToken/appSecret (apenas status)", async () => {
    const failingFetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const adapter = makeAdapter(failingFetch);
    const result = await adapter.send(ACCOUNT, {
      conversationId: "conv-1",
      type: MessageType.TEXT,
      body: "oi",
    });
    expect(result.accepted).toBe(false);
    // Loga o erro deliberadamente para provar que o valor do segredo não vaza.
    console.error("send falhou", result.error, "ref=", ACCOUNT.secretRef);
    assertNoSecretLeak();
    // A secretRef PODE aparecer (é uma referência, não um segredo).
    expect(captured.join("\n")).toContain(SECRET_REF);
  });

  it("send() bem-sucedido chama graph.facebook.com e não vaza segredos", async () => {
    const calls: string[] = [];
    const okFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = makeAdapter(okFetch);
    const result = await adapter.send(ACCOUNT, {
      conversationId: "conv-1",
      type: MessageType.TEXT,
      body: "oi",
    });
    expect(result.accepted).toBe(true);
    expect(calls[0]).toContain(WHATSAPP_CLOUD_HOST);
    assertNoSecretLeak();
  });
});
