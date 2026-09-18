/**
 * Property 9 — Janela de 24h do WhatsApp (Req 6.8).
 *
 * Fonte: `.kiro/specs/helpdesk-omnichannel/design.md` (Correctness Property 9):
 *   "∀ OutboundMessage fora da janela — o envio só é aceito se `templateName`
 *    estiver presente; caso contrário é rejeitado."
 *
 * Estratégia: `fast-check` sobre estados de janela (expirada/ausente/aberta) e
 * presença/ausência de `templateName`. O `fetch` é STUBADO — NUNCA tocamos a
 * rede. Asserções-chave:
 *  - REJEITADO (fora da janela, sem template): `accepted === false` E o fetch
 *    NÃO foi chamado (rejeição acontece ANTES da Cloud API).
 *  - ACEITO (dentro da janela OU com template): o fetch STUBADO é chamado
 *    exatamente uma vez, contra `graph.facebook.com`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ChannelAccountRef } from "@/lib/channels/adapter";
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
import type { OutboundMessage } from "@/lib/domain";

const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const SECRETS: WhatsAppSecrets = {
  appSecret: "APP_SECRET_VALUE",
  verifyToken: "VERIFY_TOKEN_VALUE",
  accessToken: "ACCESS_TOKEN_VALUE",
  phoneNumberId: "123456789",
};

const ACCOUNT: ChannelAccountRef = {
  id: "acc-1",
  companyId: "company-1",
  type: ChannelType.WHATSAPP,
  provider: ChannelProvider.WHATSAPP_CLOUD,
  externalId: "123456789",
  secretRef: "secret://whatsapp/acc-1",
};

/** Estados possíveis da janela relativos a `FIXED_NOW`. */
type WindowState = "expired" | "none" | "inside";

function windowResolverFor(state: WindowState) {
  return async (): Promise<Date | null> => {
    switch (state) {
      case "expired":
        return new Date(FIXED_NOW - 60 * 60 * 1000); // 1h atrás
      case "none":
        return null;
      case "inside":
        return new Date(FIXED_NOW + 60 * 60 * 1000); // 1h à frente
    }
  };
}

/** Cria um `fetch` stub que registra as chamadas e responde 200 com um wamid. */
function makeFetchStub() {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT.1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("Property 9 — janela de 24h do WhatsApp (cloud, fetch stubado)", () => {
  it("fora da janela: aceito SSE templateName presente; rejeição não chama a Cloud API", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<WindowState>("expired", "none"),
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        async (windowState, templateName) => {
          const { calls, fetchImpl } = makeFetchStub();
          const adapter = createWhatsAppCloudAdapter({
            resolveSecrets: async () => SECRETS,
            resolveAccount: async () => ({ id: "acc-1", companyId: "company-1" }),
            resolveWindow: windowResolverFor(windowState),
            fetchImpl,
            now: () => FIXED_NOW,
          });

          const msg: OutboundMessage = {
            conversationId: "conv-1",
            type: MessageType.TEXT,
            body: "olá",
            ...(templateName ? { templateName } : {}),
          };

          const result = await adapter.send(ACCOUNT, msg);
          const hasTemplate = typeof templateName === "string" && templateName.length > 0;

          if (hasTemplate) {
            // Template fora da janela -> aceito -> exatamente 1 chamada à API.
            expect(result.accepted).toBe(true);
            expect(calls.length).toBe(1);
            expect(calls[0]).toContain(WHATSAPP_CLOUD_HOST);
          } else {
            // Sem template fora da janela -> rejeitado ANTES da API.
            expect(result.accepted).toBe(false);
            expect(result.externalId).toBe("");
            expect(typeof result.error).toBe("string");
            expect(calls.length).toBe(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("dentro da janela: formato livre e template são aceitos e chamam a Cloud API (graph.facebook.com)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        async (templateName) => {
          const { calls, fetchImpl } = makeFetchStub();
          const adapter = createWhatsAppCloudAdapter({
            resolveSecrets: async () => SECRETS,
            resolveAccount: async () => ({ id: "acc-1", companyId: "company-1" }),
            resolveWindow: windowResolverFor("inside"),
            fetchImpl,
            now: () => FIXED_NOW,
          });

          const msg: OutboundMessage = {
            conversationId: "conv-1",
            type: MessageType.TEXT,
            body: "dentro da janela",
            ...(templateName ? { templateName } : {}),
          };

          const result = await adapter.send(ACCOUNT, msg);
          expect(result.accepted).toBe(true);
          expect(result.externalId).toBe("wamid.OUT.1");
          expect(calls.length).toBe(1);
          expect(calls[0]).toContain(WHATSAPP_CLOUD_HOST);
        },
      ),
      { numRuns: 100 },
    );
  });
});
