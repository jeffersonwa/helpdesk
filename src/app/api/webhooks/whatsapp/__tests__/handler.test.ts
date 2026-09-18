/**
 * Testes de integração dos route handlers do WhatsApp (tarefa 21.2).
 *
 * Estilo UNIT de handler: invocam as funções PURAS `handleWhatsAppGet`/
 * `handleWhatsAppPost` com `RawRequest` construído à mão e STUBS de adapter +
 * router. NÃO tocam banco/rede.
 *
 * Cobrem (Req 5.2, 5.3, 6.5, 6.6):
 *   - GET handshake: token válido ecoa `hub.challenge`; inválido → 403.
 *   - POST assinatura inválida → 401 e NENHUM `Message`/`Ticket` (router e
 *     `parseInbound` NÃO invocados) — a assinatura é verificada ANTES do parse.
 *   - POST válido → 200 rápido; cada mensagem é roteada.
 *   - `IngestionError` por mensagem é isolado (descarta e continua), sem falhar
 *     o ack 200.
 *
 * Também usa o `WhatsAppCloudAdapter` REAL (com resolvedores injetados) para
 * provar, com HMAC verdadeiro, que assinatura inválida nunca chega ao parse.
 */

import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter, RawRequest } from "@/lib/channels/adapter";
import { ChannelProvider, ChannelType, MessageType } from "@/lib/domain";
import type { InboundMessage } from "@/lib/domain";
import { IngestionError } from "@/lib/ingestion/router";
import {
  createWhatsAppCloudAdapter,
  type WhatsAppSecrets,
} from "@/lib/channels/whatsapp/cloud-adapter";

import {
  handleWhatsAppGet,
  handleWhatsAppPost,
  type WhatsAppHandlerDeps,
} from "../handler";

// ---------------------------------------------------------------------------
// Stubs / helpers
// ---------------------------------------------------------------------------

const VERIFY_TOKEN = "verify-token-dev";
const APP_SECRET = "app-secret-dev";
const SECRET_REF = "whatsapp:default";

const secrets: WhatsAppSecrets = {
  appSecret: APP_SECRET,
  verifyToken: VERIFY_TOKEN,
  accessToken: "access-token-dev",
  phoneNumberId: "PN-123",
};

/** Payload de webhook da Meta com uma mensagem de texto. */
const WEBHOOK_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "PN-123" },
            contacts: [{ wa_id: "5511999998888", profile: { name: "Fulano" } }],
            messages: [
              {
                from: "5511999998888",
                id: "wamid.ABC-1",
                type: "text",
                timestamp: "1700000000",
                text: { body: "Olá" },
              },
            ],
          },
        },
      ],
    },
  ],
});

/** Assinatura HMAC-SHA256 correta de um corpo bruto. */
function sign(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex");
}

/** Um adapter FAKE controlável, com espiões em verify/parse. */
function makeFakeAdapter(opts: {
  verify: boolean;
  messages?: InboundMessage[];
}): ChannelAdapter & {
  verifySpy: ReturnType<typeof vi.fn>;
  parseSpy: ReturnType<typeof vi.fn>;
} {
  const verifySpy = vi.fn(async () => opts.verify);
  const parseSpy = vi.fn(async () => opts.messages ?? []);
  return {
    type: ChannelType.WHATSAPP,
    provider: ChannelProvider.WHATSAPP_CLOUD,
    capabilities: () => ({
      supportsMedia: true,
      supportsTemplates: true,
      hasSessionWindow: true,
      sessionWindowHours: 24,
    }),
    verifyInbound: verifySpy as unknown as ChannelAdapter["verifyInbound"],
    parseInbound: parseSpy as unknown as ChannelAdapter["parseInbound"],
    send: vi.fn(async () => ({ externalId: "", accepted: false })),
    verifySpy,
    parseSpy,
  };
}

function makeMessage(externalId: string): InboundMessage {
  return {
    companyId: "company-1",
    channelAccountId: "acc-1",
    contactExternalId: "5511999998888",
    type: MessageType.TEXT,
    body: "Olá",
    externalId,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
  };
}

// ---------------------------------------------------------------------------
// GET handshake (Req 6.3/6.4)
// ---------------------------------------------------------------------------

describe("handleWhatsAppGet — handshake de verificação", () => {
  const cloudDeps = (): WhatsAppHandlerDeps => ({
    adapter: createWhatsAppCloudAdapter({
      resolveSecrets: async () => secrets,
      resolveAccount: async () => ({ id: "acc-1", companyId: "company-1" }),
      resolveWindow: async () => null,
    }),
    route: vi.fn(async () => undefined),
  });

  it("token válido → 200 e ecoa hub.challenge em text/plain", async () => {
    const req: RawRequest = {
      method: "GET",
      headers: {},
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "CHALLENGE-42",
        __secretRef: SECRET_REF,
      },
      rawBody: "",
    };
    const res = await handleWhatsAppGet(req, cloudDeps());
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("text/plain");
    expect(res.body).toBe("CHALLENGE-42");
  });

  it("token inválido → 403 e NÃO retorna o challenge", async () => {
    const req: RawRequest = {
      method: "GET",
      headers: {},
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "TOKEN-ERRADO",
        "hub.challenge": "CHALLENGE-42",
        __secretRef: SECRET_REF,
      },
      rawBody: "",
    };
    const res = await handleWhatsAppGet(req, cloudDeps());
    expect(res.status).toBe(403);
    expect(res.contentType).toBe("application/json");
    expect(res.body).not.toBe("CHALLENGE-42");
  });
});

// ---------------------------------------------------------------------------
// POST — assinatura ANTES do parse (Req 6.5/6.6)
// ---------------------------------------------------------------------------

describe("handleWhatsAppPost — verificação de assinatura antes do parse", () => {
  it("assinatura inválida → 401 e NÃO chama parseInbound nem route (nenhum Message/Ticket)", async () => {
    const adapter = makeFakeAdapter({ verify: false });
    const route = vi.fn(async () => undefined);
    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      query: { __secretRef: SECRET_REF },
      rawBody: WEBHOOK_BODY,
    };

    const res = await handleWhatsAppPost(req, { adapter, route });

    expect(res.status).toBe(401);
    expect(adapter.verifySpy).toHaveBeenCalledTimes(1);
    // Prova de "assinatura antes de parse": parse e route NUNCA chamados.
    expect(adapter.parseSpy).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it("adapter Cloud REAL: HMAC inválido nunca alcança o parse (401)", async () => {
    const routeSpy = vi.fn(async () => undefined);
    const parseSpy = vi.fn();
    const realAdapter = createWhatsAppCloudAdapter({
      resolveSecrets: async () => secrets,
      resolveAccount: async () => ({ id: "acc-1", companyId: "company-1" }),
      resolveWindow: async () => null,
    });
    // Espiona parseInbound para garantir que não é chamado.
    const spy = vi.spyOn(realAdapter, "parseInbound");
    void parseSpy;

    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=0000" }, // assinatura errada
      query: { __secretRef: SECRET_REF },
      rawBody: WEBHOOK_BODY,
    };

    const res = await handleWhatsAppPost(req, {
      adapter: realAdapter,
      route: routeSpy,
    });

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it("adapter Cloud REAL: HMAC válido → 200 e roteia a mensagem parseada", async () => {
    const routed: InboundMessage[] = [];
    const routeSpy = vi.fn(async (m: InboundMessage) => {
      routed.push(m);
    });
    const realAdapter = createWhatsAppCloudAdapter({
      resolveSecrets: async () => secrets,
      resolveAccount: async () => ({ id: "acc-1", companyId: "company-1" }),
      resolveWindow: async () => null,
    });

    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": sign(WEBHOOK_BODY) },
      query: { __secretRef: SECRET_REF },
      rawBody: WEBHOOK_BODY,
    };

    const res = await handleWhatsAppPost(req, {
      adapter: realAdapter,
      route: routeSpy,
    });

    expect(res.status).toBe(200);
    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(routed[0]?.externalId).toBe("wamid.ABC-1");
    expect(routed[0]?.companyId).toBe("company-1");
  });
});

// ---------------------------------------------------------------------------
// POST — resposta 200 rápida + roteamento por mensagem
// ---------------------------------------------------------------------------

describe("handleWhatsAppPost — 200 rápido e roteamento", () => {
  it("assinatura válida → 200 e roteia cada mensagem", async () => {
    const msgs = [makeMessage("wamid.1"), makeMessage("wamid.2")];
    const adapter = makeFakeAdapter({ verify: true, messages: msgs });
    const route = vi.fn(async () => undefined);

    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=ok" },
      query: { __secretRef: SECRET_REF },
      rawBody: WEBHOOK_BODY,
    };

    const res = await handleWhatsAppPost(req, { adapter, route });

    expect(res.status).toBe(200);
    expect(adapter.parseSpy).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(2);
    expect(res.body).toMatchObject({ received: 2, routed: 2, discarded: 0 });
  });

  it("IngestionError por mensagem é isolado (descarta e continua) sem falhar o 200", async () => {
    const msgs = [makeMessage("wamid.ok"), makeMessage("wamid.bad")];
    const adapter = makeFakeAdapter({ verify: true, messages: msgs });
    const route = vi.fn(async (m: InboundMessage) => {
      if (m.externalId === "wamid.bad") {
        throw new IngestionError("TENANT_MISMATCH", "divergência");
      }
    });

    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=ok" },
      query: { __secretRef: SECRET_REF },
      rawBody: WEBHOOK_BODY,
    };

    const res = await handleWhatsAppPost(req, { adapter, route });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: 2, routed: 1, discarded: 1 });
  });

  it("sem mensagens (payload de status) → 200 com received=0", async () => {
    const adapter = makeFakeAdapter({ verify: true, messages: [] });
    const route = vi.fn(async () => undefined);
    const req: RawRequest = {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=ok" },
      query: { __secretRef: SECRET_REF },
      rawBody: "{}",
    };
    const res = await handleWhatsAppPost(req, { adapter, route });
    expect(res.status).toBe(200);
    expect(route).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ received: 0, routed: 0, discarded: 0 });
  });
});
