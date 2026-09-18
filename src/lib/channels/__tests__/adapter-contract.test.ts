/**
 * Execução da suíte de contrato compartilhada (tarefa 13.2).
 *
 * Como ainda não existe adaptador concreto (o Cloud vem na tarefa 14 e o MOCK
 * na tarefa 15), este arquivo define um FAKE mínimo (test double) que
 * implementa `ChannelAdapter` apenas para exercitar o harness AGORA — tornando
 * a tarefa 13.2 autoverificável. As tarefas 14/15 rodarão exatamente o mesmo
 * `runChannelAdapterContract` contra o adaptador real e o MOCK.
 *
 * Também cobre a seleção de provider por env e o bloqueio do MOCK em produção
 * (Req 5.7, 5.8) definidos em `registry.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";

import type {
  ChannelAccountRef,
  ChannelAdapter,
  RawRequest,
} from "@/lib/channels/adapter";
import {
  assertMockAllowed,
  clearRegistry,
  getAdapter,
  isMockAllowed,
  isMockProvider,
  registerAdapter,
  resolveWhatsAppProvider,
} from "@/lib/channels/registry";
import { ChannelProvider, ChannelType, MessageType } from "@/lib/domain";
import type { InboundMessage, OutboundMessage, SendResult } from "@/lib/domain";

import {
  runChannelAdapterContract,
  type ChannelAdapterContractFixtures,
} from "./adapter-contract";

/**
 * FAKE adapter — test double APENAS deste arquivo de teste.
 *
 * Não faz I/O; apenas devolve estruturas no formato do contrato para provar
 * que o harness valida corretamente qualquer implementação. NÃO é o MOCK de
 * desenvolvimento (tarefa 15) nem o Cloud (tarefa 14).
 */
class FakeChannelAdapter implements ChannelAdapter {
  readonly type = ChannelType.WHATSAPP;
  readonly provider = ChannelProvider.WHATSAPP_MOCK;

  capabilities() {
    return {
      supportsMedia: true,
      supportsTemplates: true,
      hasSessionWindow: true,
      sessionWindowHours: 24,
    };
  }

  async verifyInbound(req: RawRequest): Promise<boolean> {
    // Fake: aceita qualquer requisição não vazia.
    return req.rawBody.length >= 0;
  }

  async parseInbound(req: RawRequest): Promise<InboundMessage[]> {
    void req;
    return [
      {
        companyId: "company-1",
        channelAccountId: "acc-1",
        contactExternalId: "+5511999998888",
        contactName: "Fulano de Tal",
        type: MessageType.TEXT,
        body: "Olá",
        externalId: "wamid.FAKE-001",
        timestamp: new Date("2026-01-01T12:00:00.000Z"),
      },
    ];
  }

  async send(
    account: ChannelAccountRef,
    msg: OutboundMessage,
  ): Promise<SendResult> {
    void account;
    void msg;
    return { externalId: "wamid.FAKE-OUT-001", accepted: true };
  }
}

const fixtures: ChannelAdapterContractFixtures = {
  validInboundRequest: {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=deadbeef" },
    query: {},
    rawBody: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
  },
  account: {
    id: "acc-1",
    companyId: "company-1",
    type: ChannelType.WHATSAPP,
    provider: ChannelProvider.WHATSAPP_MOCK,
    externalId: "123456789",
    secretRef: "secret://whatsapp/company-1",
  },
  outbound: {
    conversationId: "conv-1",
    type: MessageType.TEXT,
    body: "Resposta do atendente",
  },
};

// Property 12 — o harness compartilhado valida o formato do contrato para a
// implementação FAKE. Mesma suíte será reutilizada pelo mock e pelo real.
runChannelAdapterContract(
  "FakeChannelAdapter (test double)",
  () => new FakeChannelAdapter(),
  fixtures,
);

describe("registry — seleção de provider por env", () => {
  it("mapeia whatsapp_cloud -> WHATSAPP_CLOUD", () => {
    expect(
      resolveWhatsAppProvider({ CHANNEL_WHATSAPP_PROVIDER: "whatsapp_cloud" }),
    ).toBe(ChannelProvider.WHATSAPP_CLOUD);
  });

  it("mapeia whatsapp_mock -> WHATSAPP_MOCK", () => {
    expect(
      resolveWhatsAppProvider({ CHANNEL_WHATSAPP_PROVIDER: "whatsapp_mock" }),
    ).toBe(ChannelProvider.WHATSAPP_MOCK);
  });

  it("é case-insensitive e tolera espaços", () => {
    expect(
      resolveWhatsAppProvider({ CHANNEL_WHATSAPP_PROVIDER: "  WhatsApp_Cloud  " }),
    ).toBe(ChannelProvider.WHATSAPP_CLOUD);
  });

  it("padrão fora de produção é MOCK", () => {
    expect(resolveWhatsAppProvider({ NODE_ENV: "development" })).toBe(
      ChannelProvider.WHATSAPP_MOCK,
    );
    expect(resolveWhatsAppProvider({ NODE_ENV: "test" })).toBe(
      ChannelProvider.WHATSAPP_MOCK,
    );
  });

  it("padrão em produção é CLOUD", () => {
    expect(resolveWhatsAppProvider({ NODE_ENV: "production" })).toBe(
      ChannelProvider.WHATSAPP_CLOUD,
    );
  });

  it("valor desconhecido cai no padrão do ambiente", () => {
    expect(
      resolveWhatsAppProvider({ CHANNEL_WHATSAPP_PROVIDER: "nope", NODE_ENV: "production" }),
    ).toBe(ChannelProvider.WHATSAPP_CLOUD);
  });
});

describe("registry — bloqueio do MOCK em produção (Req 5.8)", () => {
  it("isMockProvider identifica providers mock", () => {
    expect(isMockProvider(ChannelProvider.WHATSAPP_MOCK)).toBe(true);
    expect(isMockProvider(ChannelProvider.WHATSAPP_CLOUD)).toBe(false);
  });

  it("isMockAllowed é false em produção e true fora dela", () => {
    expect(isMockAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(isMockAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(isMockAllowed({ NODE_ENV: "test" })).toBe(true);
  });

  it("assertMockAllowed lança em produção", () => {
    expect(() => assertMockAllowed({ NODE_ENV: "production" })).toThrow(
      /MOCK não é permitido em produção/i,
    );
  });

  it("assertMockAllowed não lança fora de produção", () => {
    expect(() => assertMockAllowed({ NODE_ENV: "development" })).not.toThrow();
  });
});

describe("registry — registro e recuperação de adaptadores", () => {
  afterEach(() => {
    clearRegistry();
  });

  it("registra e recupera por (type, provider)", () => {
    const adapter = new FakeChannelAdapter();
    registerAdapter(adapter);
    expect(getAdapter(ChannelType.WHATSAPP, ChannelProvider.WHATSAPP_MOCK)).toBe(
      adapter,
    );
  });

  it("retorna undefined para par não registrado", () => {
    expect(
      getAdapter(ChannelType.EMAIL, ChannelProvider.EMAIL_IMAP),
    ).toBeUndefined();
  });
});
