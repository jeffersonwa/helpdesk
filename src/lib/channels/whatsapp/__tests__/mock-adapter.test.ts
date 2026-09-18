/**
 * Testes do `WhatsAppMockAdapter` (tarefa 15.2):
 *  - Executa a suíte de contrato COMPARTILHADA (`runChannelAdapterContract`)
 *    contra o MOCK (Property 12, Req 5.7);
 *  - Executa a MESMA suíte contra o Cloud (com `fetch`/resolvers stubados),
 *    provando que ambos produzem `InboundMessage`/`SendResult` de formato
 *    idêntico;
 *  - Valida a paridade da janela de 24h no MOCK (Property 9);
 *  - Valida o BLOQUEIO em produção (Req 5.8): construir o MOCK com
 *    `NODE_ENV=production` LANÇA.
 */

import { describe, expect, it } from "vitest";

import type { ChannelAccountRef, RawRequest } from "@/lib/channels/adapter";
import { runChannelAdapterContract } from "@/lib/channels/__tests__/adapter-contract";
import {
  createWhatsAppCloudAdapter,
  type WhatsAppSecrets,
} from "@/lib/channels/whatsapp/cloud-adapter";
import {
  WhatsAppMockAdapter,
  createWhatsAppMockAdapter,
} from "@/lib/channels/whatsapp/mock-adapter";
import {
  ChannelProvider,
  ChannelType,
  MessageType,
} from "@/lib/domain";
import type { OutboundMessage } from "@/lib/domain";

/** Payload de webhook da Meta (forma compartilhada por mock e cloud). */
const VALID_WEBHOOK_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "5511999990000",
              phone_number_id: "PN_123",
            },
            contacts: [{ profile: { name: "Cliente Teste" }, wa_id: "5511988887777" }],
            messages: [
              {
                from: "5511988887777",
                id: "wamid.IN.1",
                timestamp: "1768478400",
                type: "text",
                text: { body: "Olá, preciso de ajuda" },
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
});

const VALID_INBOUND_REQUEST: RawRequest = {
  method: "POST",
  headers: { "x-hub-signature-256": "sha256=deadbeef" },
  query: { __secretRef: "secret://whatsapp/acc-1" },
  rawBody: VALID_WEBHOOK_BODY,
};

const ACCOUNT: ChannelAccountRef = {
  id: "acc-1",
  companyId: "mock-company",
  type: ChannelType.WHATSAPP,
  provider: ChannelProvider.WHATSAPP_MOCK,
  externalId: "PN_123",
  secretRef: "secret://whatsapp/acc-1",
};

const OUTBOUND: OutboundMessage = {
  conversationId: "conv-1",
  type: MessageType.TEXT,
  body: "Resposta do agente",
};

// --- Contrato compartilhado contra o MOCK (janela aberta por padrão em DEV) ---
runChannelAdapterContract(
  "WhatsAppMockAdapter",
  () => createWhatsAppMockAdapter({ env: { NODE_ENV: "test" } }),
  {
    validInboundRequest: VALID_INBOUND_REQUEST,
    account: ACCOUNT,
    outbound: OUTBOUND,
  },
);

// --- Contrato compartilhado contra o CLOUD (fetch + resolvers stubados) ---
const CLOUD_SECRETS: WhatsAppSecrets = {
  appSecret: "APP_SECRET",
  verifyToken: "VERIFY_TOKEN",
  accessToken: "ACCESS_TOKEN",
  phoneNumberId: "PN_123",
};

runChannelAdapterContract(
  "WhatsAppCloudAdapter",
  () =>
    createWhatsAppCloudAdapter({
      resolveSecrets: async () => CLOUD_SECRETS,
      resolveAccount: async () => ({ id: "acc-1", companyId: "mock-company" }),
      resolveWindow: async () => new Date(Date.now() + 60 * 60 * 1000),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.OUT.1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    }),
  {
    validInboundRequest: VALID_INBOUND_REQUEST,
    account: {
      ...ACCOUNT,
      provider: ChannelProvider.WHATSAPP_CLOUD,
    },
    outbound: OUTBOUND,
  },
);

describe("WhatsAppMockAdapter — paridade e bloqueio de produção", () => {
  it("parseInbound produz InboundMessage com o mesmo formato do Cloud", async () => {
    const mock = createWhatsAppMockAdapter({ env: { NODE_ENV: "test" } });
    const cloud = createWhatsAppCloudAdapter({
      resolveSecrets: async () => CLOUD_SECRETS,
      resolveAccount: async () => ({ id: "acc-1", companyId: "mock-company" }),
      resolveWindow: async () => new Date(Date.now() + 3600_000),
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });

    const [mockMsg] = await mock.parseInbound(VALID_INBOUND_REQUEST);
    const [cloudMsg] = await cloud.parseInbound(VALID_INBOUND_REQUEST);

    expect(Object.keys(mockMsg).sort()).toEqual(Object.keys(cloudMsg).sort());
    expect(mockMsg.type).toBe(MessageType.TEXT);
    expect(mockMsg.contactExternalId).toBe("5511988887777");
    expect(mockMsg.contactName).toBe("Cliente Teste");
    expect(mockMsg.body).toBe("Olá, preciso de ajuda");
    expect(mockMsg.externalId).toBe("wamid.IN.1");
    expect(mockMsg.timestamp.getTime()).toBe(1768478400 * 1000);
  });

  it("Property 9 no MOCK: fora da janela sem template é rejeitado; com template aceito", async () => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const mock = createWhatsAppMockAdapter({
      env: { NODE_ENV: "test" },
      resolveWindow: async () => new Date(now - 3600_000), // expirada
      now: () => now,
    });

    const rejected = await mock.send(ACCOUNT, { ...OUTBOUND });
    expect(rejected.accepted).toBe(false);
    expect(rejected.externalId).toBe("");
    expect(mock.sent.length).toBe(0);

    const accepted = await mock.send(ACCOUNT, {
      ...OUTBOUND,
      templateName: "boas_vindas",
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.externalId).toMatch(/^mock-wamid-/);
    expect(mock.sent.length).toBe(1);
  });

  it("send dentro da janela registra a saída em memória", async () => {
    const mock = createWhatsAppMockAdapter({ env: { NODE_ENV: "test" } });
    const result = await mock.send(ACCOUNT, OUTBOUND);
    expect(result.accepted).toBe(true);
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0].externalId).toBe(result.externalId);
  });

  it("BLOQUEIO EM PRODUÇÃO (Req 5.8): construir com NODE_ENV=production lança", () => {
    expect(
      () => new WhatsAppMockAdapter({ env: { NODE_ENV: "production" } }),
    ).toThrow(/produção/i);
    expect(() =>
      createWhatsAppMockAdapter({ env: { NODE_ENV: "production" } }),
    ).toThrow(/produção/i);
  });

  it("permitido fora de produção (dev/test)", () => {
    expect(() =>
      createWhatsAppMockAdapter({ env: { NODE_ENV: "development" } }),
    ).not.toThrow();
    expect(() =>
      createWhatsAppMockAdapter({ env: { NODE_ENV: "test" } }),
    ).not.toThrow();
  });
});
