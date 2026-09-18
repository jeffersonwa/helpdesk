/**
 * `WhatsAppMockAdapter` — provider de DESENVOLVIMENTO que implementa a MESMA
 * interface `ChannelAdapter` do adaptador Cloud real, SEM chamadas externas.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Adapter real vs. mock") e requisitos 5.7, 5.8.
 *
 * ------------------------------------------------------------------------
 * REGRAS INVIOLÁVEIS
 * ------------------------------------------------------------------------
 *  - BLOQUEADO EM PRODUÇÃO (Req 5.8): a construção/habilitação chama
 *    `assertMockAllowed(env)` (de `registry.ts`), que LANÇA quando
 *    `NODE_ENV === "production"`.
 *  - PARIDADE COMPORTAMENTAL (Req 5.7 / Property 12): produz `InboundMessage`
 *    e `SendResult` no MESMO formato do Cloud, e aplica a MESMA regra da
 *    janela de 24h (Property 9) — para que o contrato compartilhado valha
 *    igualmente para mock e real.
 *  - SEM chamadas externas: `send` grava a saída em memória e devolve um
 *    `externalId` sintético (`mock-wamid-...`).
 */

import { randomUUID } from "node:crypto";

import type {
  ChannelAccountRef,
  ChannelAdapter,
  RawRequest,
} from "@/lib/channels/adapter";
import { assertMockAllowed } from "@/lib/channels/registry";
import {
  ChannelProvider,
  ChannelType,
  MessageType,
} from "@/lib/domain";
import type {
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "@/lib/domain";
import {
  WHATSAPP_SESSION_WINDOW_HOURS,
  type AccountResolver,
  type WindowResolver,
} from "@/lib/channels/whatsapp/cloud-adapter";

type Env = Record<string, string | undefined>;

/** Registro em memória de um envio simulado. */
export interface MockSentMessage {
  account: ChannelAccountRef;
  message: OutboundMessage;
  externalId: string;
  at: Date;
}

/** Dependências injetadas do MOCK. Todas têm padrões seguros de DEV. */
export interface WhatsAppMockAdapterDeps {
  /** Ambiente para a guarda de produção. Padrão: `process.env`. */
  env?: Env;
  /**
   * `verify_token` de DEV usado no handshake GET. Padrão: `"mock-verify-token"`.
   * NÃO é um segredo real; é um valor de desenvolvimento óbvio.
   */
  devVerifyToken?: string;
  /** Resolve a conta por `phone_number_id`. Padrão: eco de valores de DEV. */
  resolveAccount?: AccountResolver;
  /** Resolve a janela de 24h. Padrão: sempre aberta (DEV). */
  resolveWindow?: WindowResolver;
  /** Relógio injetável. Padrão: `Date.now`. */
  now?: () => number;
}

/** Mapeia o tipo de mensagem da Meta para o `MessageType` do domínio. */
function mapMetaMessageType(metaType: string): MessageType {
  switch (metaType) {
    case "text":
      return MessageType.TEXT;
    case "image":
      return MessageType.IMAGE;
    case "document":
      return MessageType.DOCUMENT;
    case "audio":
      return MessageType.AUDIO;
    case "video":
      return MessageType.VIDEO;
    case "template":
      return MessageType.TEMPLATE;
    default:
      return MessageType.SYSTEM;
  }
}

/**
 * `WhatsAppMockAdapter` — mesma interface do Cloud, sem I/O externo.
 * Bloqueado em produção por construção.
 */
export class WhatsAppMockAdapter implements ChannelAdapter {
  readonly type = ChannelType.WHATSAPP;
  readonly provider = ChannelProvider.WHATSAPP_MOCK;

  /** Saídas simuladas registradas em memória (inspecionáveis em testes/DEV). */
  readonly sent: MockSentMessage[] = [];

  private readonly devVerifyToken: string;
  private readonly resolveAccount: AccountResolver;
  private readonly resolveWindow: WindowResolver;
  private readonly now: () => number;

  constructor(deps: WhatsAppMockAdapterDeps = {}) {
    // Req 5.8 — BLOQUEIO EM PRODUÇÃO: lança se NODE_ENV === "production".
    assertMockAllowed(deps.env ?? process.env);

    this.devVerifyToken = deps.devVerifyToken ?? "mock-verify-token";
    this.resolveAccount =
      deps.resolveAccount ??
      ((phoneNumberId: string) =>
        Promise.resolve({
          id: `mock-account-${phoneNumberId}`,
          companyId: "mock-company",
        }));
    // Janela sempre aberta por padrão em DEV; testes podem sobrepor.
    this.resolveWindow =
      deps.resolveWindow ??
      (() =>
        Promise.resolve(
          new Date((deps.now ?? (() => Date.now()))() + 60 * 60 * 1000),
        ));
    this.now = deps.now ?? (() => Date.now());
  }

  capabilities(): ChannelCapabilities {
    // Mesmas capacidades do Cloud (Property 12).
    return {
      supportsMedia: true,
      supportsTemplates: true,
      hasSessionWindow: true,
      sessionWindowHours: WHATSAPP_SESSION_WINDOW_HOURS,
    };
  }

  /**
   * Esquema de verificação de DEV (documentado como mock):
   *  - GET: handshake contra o `devVerifyToken` (mesma lógica de `hub.mode`).
   *  - POST: sempre "verificado" em DEV (não há segredo real para HMAC).
   */
  async verifyInbound(req: RawRequest): Promise<boolean> {
    if (req.method.toUpperCase() === "GET") {
      return (
        req.query["hub.mode"] === "subscribe" &&
        req.query["hub.verify_token"] === this.devVerifyToken
      );
    }
    // DEV: POST considerado verificado (sem chamadas/segredos externos).
    return true;
  }

  /**
   * Normaliza o corpo bruto no MESMO formato do Cloud. Aceita a mesma forma da
   * Meta (`entry[].changes[].value.messages[]`), garantindo que o contrato
   * compartilhado (Property 12) valha com fixtures equivalentes.
   */
  async parseInbound(req: RawRequest): Promise<InboundMessage[]> {
    let payload: unknown;
    try {
      payload = JSON.parse(req.rawBody);
    } catch {
      return [];
    }

    const result: InboundMessage[] = [];
    for (const entry of this.readArray(payload, "entry")) {
      for (const change of this.readArray(entry, "changes")) {
        const value = this.readObject(change, "value");
        if (!value) {
          continue;
        }
        const metadata = this.readObject(value, "metadata");
        const phoneNumberId =
          metadata && typeof metadata.phone_number_id === "string"
            ? metadata.phone_number_id
            : undefined;
        if (!phoneNumberId) {
          continue;
        }
        const account = await this.resolveAccount(phoneNumberId);
        if (!account) {
          continue;
        }

        const contactNames = new Map<string, string>();
        for (const contact of this.readArray(value, "contacts")) {
          const c = contact as Record<string, unknown>;
          const waId = typeof c.wa_id === "string" ? c.wa_id : undefined;
          const profile = c.profile as Record<string, unknown> | undefined;
          const name =
            profile && typeof profile.name === "string"
              ? profile.name
              : undefined;
          if (waId && name) {
            contactNames.set(waId, name);
          }
        }

        for (const rawMsg of this.readArray(value, "messages")) {
          const message = rawMsg as Record<string, unknown>;
          const from =
            typeof message.from === "string" ? message.from : undefined;
          const externalId =
            typeof message.id === "string" ? message.id : undefined;
          const metaType =
            typeof message.type === "string" ? message.type : "unknown";
          if (!from || !externalId) {
            continue;
          }

          const tsSeconds =
            typeof message.timestamp === "string"
              ? Number.parseInt(message.timestamp, 10)
              : typeof message.timestamp === "number"
                ? message.timestamp
                : NaN;
          const timestamp = Number.isFinite(tsSeconds)
            ? new Date(tsSeconds * 1000)
            : new Date(this.now());

          const inbound: InboundMessage = {
            companyId: account.companyId,
            channelAccountId: account.id,
            contactExternalId: from,
            type: mapMetaMessageType(metaType),
            externalId,
            timestamp,
          };
          const contactName = contactNames.get(from);
          if (contactName !== undefined) {
            inbound.contactName = contactName;
          }
          const text = message.text as Record<string, unknown> | undefined;
          if (text && typeof text.body === "string") {
            inbound.body = text.body;
          }
          const mediaNode = message[metaType] as
            | Record<string, unknown>
            | undefined;
          if (mediaNode && typeof mediaNode.id === "string") {
            inbound.mediaRef = mediaNode.id;
          }

          result.push(inbound);
        }
      }
    }
    return result;
  }

  /**
   * Registra a saída em memória. Aplica a MESMA regra da janela de 24h do
   * Cloud (Property 9): fora da janela sem `templateName` ⇒ rejeitado, sem
   * registrar envio.
   */
  async send(
    account: ChannelAccountRef,
    msg: OutboundMessage,
  ): Promise<SendResult> {
    const hasTemplate =
      typeof msg.templateName === "string" && msg.templateName.length > 0;

    if (!hasTemplate) {
      const windowExpiresAt = await this.resolveWindow(msg.conversationId);
      const insideWindow =
        windowExpiresAt !== null && windowExpiresAt.getTime() > this.now();
      if (!insideWindow) {
        return {
          externalId: "",
          accepted: false,
          error:
            "Fora da janela de 24h do WhatsApp: mensagem de template " +
            "(templateName) é obrigatória para enviar.",
        };
      }
    }

    const externalId = `mock-wamid-${randomUUID()}`;
    this.sent.push({
      account,
      message: msg,
      externalId,
      at: new Date(this.now()),
    });
    return { externalId, accepted: true };
  }

  private readArray(node: unknown, key: string): unknown[] {
    if (node && typeof node === "object") {
      const value = (node as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
    return [];
  }

  private readObject(
    node: unknown,
    key: string,
  ): Record<string, unknown> | undefined {
    if (node && typeof node === "object") {
      const value = (node as Record<string, unknown>)[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
    return undefined;
  }
}

/**
 * Fábrica do MOCK. Chama `assertMockAllowed` (via construtor) e retorna o
 * adaptador; NÃO registra automaticamente para evitar efeitos colaterais em
 * import — o wiring/os testes chamam `registerAdapter` explicitamente.
 */
export function createWhatsAppMockAdapter(
  deps: WhatsAppMockAdapterDeps = {},
): WhatsAppMockAdapter {
  return new WhatsAppMockAdapter(deps);
}
