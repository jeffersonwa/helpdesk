/**
 * Suíte de contrato COMPARTILHADA de adaptadores de canal (Property 12).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (Correctness Property 12) — Valida: Requisito 5.7.
 *
 * ------------------------------------------------------------------------
 * IMPORTANTE — este arquivo NÃO é um arquivo de teste executável.
 * ------------------------------------------------------------------------
 * O padrão do Vitest é `src/**\/*.{test,spec}.ts`, portanto este `.ts`
 * (sem `.test`/`.spec`) NÃO é coletado automaticamente. Ele exporta uma
 * função `runChannelAdapterContract(...)` que qualquer arquivo `.test.ts`
 * invoca, fornecendo fixtures apropriadas ao seu provider.
 *
 * A ideia (Property 12 — Intercambialidade dos adapters): o CONTRATO — os
 * formatos de `InboundMessage` e `SendResult`, e o formato de
 * `ChannelCapabilities` — é idêntico independentemente da implementação.
 * Esta suíte é o ORÁCULO comum executado por:
 *   - o adaptador MOCK (tarefa 15),
 *   - o adaptador WhatsApp Cloud real (tarefa 14),
 * garantindo que produzam o mesmo formato para entradas equivalentes.
 */

import { describe, expect, it } from "vitest";

import type {
  ChannelAccountRef,
  ChannelAdapter,
  RawRequest,
} from "@/lib/channels/adapter";
import type { InboundMessage, OutboundMessage } from "@/lib/domain";
import { MessageType } from "@/lib/domain";

/**
 * Fixtures fornecidas por cada arquivo `.test.ts` específico do adaptador.
 * Permitem que a suíte permaneça agnóstica de canal, enquanto cada provider
 * fornece entradas válidas para SUA implementação.
 */
export interface ChannelAdapterContractFixtures {
  /** Requisição bruta VÁLIDA que produz ao menos uma `InboundMessage`. */
  validInboundRequest: RawRequest;
  /** Conta usada em `send`. */
  account: ChannelAccountRef;
  /** Mensagem de saída válida para o adaptador. */
  outbound: OutboundMessage;
}

const MESSAGE_TYPES = new Set<string>(Object.values(MessageType));

/** Assere que `value` tem o formato de uma `InboundMessage` normalizada. */
function assertInboundShape(value: InboundMessage): void {
  expect(typeof value.companyId).toBe("string");
  expect(value.companyId.length).toBeGreaterThan(0);

  expect(typeof value.channelAccountId).toBe("string");
  expect(value.channelAccountId.length).toBeGreaterThan(0);

  expect(typeof value.contactExternalId).toBe("string");
  expect(value.contactExternalId.length).toBeGreaterThan(0);

  expect(MESSAGE_TYPES.has(value.type)).toBe(true);

  expect(typeof value.externalId).toBe("string");
  expect(value.externalId.length).toBeGreaterThan(0);

  expect(value.timestamp).toBeInstanceOf(Date);
  expect(Number.isNaN(value.timestamp.getTime())).toBe(false);

  // Campos opcionais, quando presentes, devem respeitar seus tipos.
  if (value.contactName !== undefined) {
    expect(typeof value.contactName).toBe("string");
  }
  if (value.body !== undefined) {
    expect(typeof value.body).toBe("string");
  }
  if (value.mediaRef !== undefined) {
    expect(typeof value.mediaRef).toBe("string");
  }
}

/**
 * Executa o contrato compartilhado contra QUALQUER implementação de
 * `ChannelAdapter`. Chamada por arquivos `.test.ts` (mock/cloud/fake).
 *
 * @param name       Rótulo do `describe` (ex.: "WhatsAppMockAdapter").
 * @param makeAdapter Fábrica que produz uma instância nova do adaptador.
 * @param fixtures   Entradas válidas específicas do provider.
 */
export function runChannelAdapterContract(
  name: string,
  makeAdapter: () => ChannelAdapter,
  fixtures: ChannelAdapterContractFixtures,
): void {
  describe(`ChannelAdapter contract — ${name}`, () => {
    it("capabilities() retorna um ChannelCapabilities bem-formado", () => {
      const caps = makeAdapter().capabilities();

      expect(typeof caps.supportsMedia).toBe("boolean");
      expect(typeof caps.supportsTemplates).toBe("boolean");
      expect(typeof caps.hasSessionWindow).toBe("boolean");

      if (caps.hasSessionWindow) {
        // Janela de sessão exige um número de horas positivo (ex.: WhatsApp = 24).
        expect(typeof caps.sessionWindowHours).toBe("number");
        expect(caps.sessionWindowHours as number).toBeGreaterThan(0);
      }
    });

    it("declara type e provider imutáveis", () => {
      const adapter = makeAdapter();
      expect(typeof adapter.type).toBe("string");
      expect(typeof adapter.provider).toBe("string");
    });

    it("verifyInbound() retorna um boolean", async () => {
      const result = await makeAdapter().verifyInbound(
        fixtures.validInboundRequest,
      );
      expect(typeof result).toBe("boolean");
    });

    it("parseInbound() retorna InboundMessage[] com o formato do contrato", async () => {
      const messages = await makeAdapter().parseInbound(
        fixtures.validInboundRequest,
      );

      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThan(0);
      for (const msg of messages) {
        assertInboundShape(msg);
      }
    });

    it("send() retorna um SendResult com { externalId, accepted } bem-formado", async () => {
      const result = await makeAdapter().send(
        fixtures.account,
        fixtures.outbound,
      );

      expect(typeof result.externalId).toBe("string");
      expect(typeof result.accepted).toBe("boolean");
      if (result.error !== undefined) {
        expect(typeof result.error).toBe("string");
      }
    });
  });
}
