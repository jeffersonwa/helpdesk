/**
 * `WhatsAppCloudAdapter` — integração REAL com a Meta WhatsApp Business Cloud API.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seções "Fluxo de Integração WhatsApp Business Cloud API" e
 * "Design de Baixo Nível" — pseudocódigo `verifyInbound`).
 *
 * ------------------------------------------------------------------------
 * RESTRIÇÕES INVIOLÁVEIS (Req 6.1, 6.2)
 * ------------------------------------------------------------------------
 *  - Todas as chamadas de saída vão EXCLUSIVAMENTE para `graph.facebook.com`
 *    (Cloud API oficial da Meta), via `fetch` nativo. NÃO existe nenhuma
 *    dependência de biblioteca de WhatsApp: proibido WhatsApp Web, QR Code,
 *    scraping ou automação de navegador.
 *  - Segredos (`app_secret`, `verify_token`, `access_token`) NUNCA são
 *    embutidos no código. São resolvidos em tempo de execução por um
 *    `SecretResolver` injetado, a partir da `secretRef` da `ChannelAccount`.
 *    Nenhum valor de segredo é registrado em log — apenas a `secretRef`.
 *
 * O adaptador é PURO em relação ao ambiente: não lê `process.env` diretamente.
 * As dependências (resolver de segredo, resolver de conta, resolver de janela e
 * o `fetch`) são INJETADAS, tornando-o testável e seguro por construção.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  ChannelAccountRef,
  ChannelAdapter,
  RawRequest,
} from "@/lib/channels/adapter";
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

/** Host oficial da Meta Cloud API — o ÚNICO destino permitido para saída. */
export const WHATSAPP_CLOUD_HOST = "graph.facebook.com" as const;
/** Versão da Graph API usada nas chamadas de saída. */
export const WHATSAPP_CLOUD_API_VERSION = "v21.0" as const;
const CLOUD_API_BASE = `https://${WHATSAPP_CLOUD_HOST}/${WHATSAPP_CLOUD_API_VERSION}`;

/** Janela de sessão do WhatsApp, em horas (Req 6.7, 6.8). */
export const WHATSAPP_SESSION_WINDOW_HOURS = 24 as const;

/**
 * Segredos resolvidos a partir de uma `secretRef`. NUNCA são logados.
 * `phoneNumberId` pode vir do segredo ou de `ChannelAccountRef.externalId`.
 */
export type WhatsAppSecrets = {
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneNumberId?: string;
};

/**
 * Resolve os segredos de uma conta a partir da sua `secretRef`.
 * O wiring da aplicação fornece a implementação real (lê de env/secret
 * manager); os testes injetam um stub — o núcleo do adaptador nunca toca
 * `process.env`.
 */
export type SecretResolver = (secretRef: string) => Promise<WhatsAppSecrets>;

/**
 * Resolve a `ChannelAccount` (tenant) a partir do `phone_number_id` recebido
 * no webhook. Retorna `null` quando a conta não pertence a nenhum tenant
 * conhecido — nesse caso a mensagem é DESCARTADA em `parseInbound`.
 */
export type AccountResolver = (
  phoneNumberId: string,
) => Promise<{ id: string; companyId: string } | null>;

/**
 * Resolve o `windowExpiresAt` de uma conversa (janela de 24h). Retorna `null`
 * quando não há janela aberta (sem mensagem recente do contato).
 */
export type WindowResolver = (
  conversationId: string,
) => Promise<Date | null>;

/** Assinatura de `fetch` — injetável para testes (stub), nativo em produção. */
export type FetchLike = typeof fetch;

/** Dependências injetadas do `WhatsAppCloudAdapter`. */
export interface WhatsAppCloudAdapterDeps {
  resolveSecrets: SecretResolver;
  resolveAccount: AccountResolver;
  resolveWindow: WindowResolver;
  /** Padrão: `globalThis.fetch` (nativo). Stub nos testes. */
  fetchImpl?: FetchLike;
  /** Relógio injetável (para testar a janela). Padrão: `Date.now`. */
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

/** Extrai a `media id` de uma mensagem de mídia da Meta, se presente. */
function extractMediaRef(
  metaType: string,
  message: Record<string, unknown>,
): string | undefined {
  const mediaNode = message[metaType];
  if (mediaNode && typeof mediaNode === "object") {
    const id = (mediaNode as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return undefined;
}

/** Extrai o corpo textual de uma mensagem da Meta, se presente. */
function extractBody(message: Record<string, unknown>): string | undefined {
  const text = message.text;
  if (text && typeof text === "object") {
    const body = (text as Record<string, unknown>).body;
    if (typeof body === "string") {
      return body;
    }
  }
  return undefined;
}

/**
 * Comparação em TEMPO CONSTANTE de duas assinaturas hex.
 * Usa `crypto.timingSafeEqual`, que exige buffers de mesmo tamanho — por isso
 * comparamos o comprimento primeiro (curto-circuito seguro: assinaturas de
 * tamanhos diferentes nunca conferem).
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * `WhatsAppCloudAdapter` — implementação de `ChannelAdapter` para o provider
 * oficial `WHATSAPP_CLOUD`.
 */
export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly type = ChannelType.WHATSAPP;
  readonly provider = ChannelProvider.WHATSAPP_CLOUD;

  private readonly resolveSecrets: SecretResolver;
  private readonly resolveAccount: AccountResolver;
  private readonly resolveWindow: WindowResolver;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(deps: WhatsAppCloudAdapterDeps) {
    this.resolveSecrets = deps.resolveSecrets;
    this.resolveAccount = deps.resolveAccount;
    this.resolveWindow = deps.resolveWindow;
    // fetch nativo por padrão; nunca uma lib de WhatsApp.
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.now = deps.now ?? (() => Date.now());
  }

  capabilities(): ChannelCapabilities {
    return {
      supportsMedia: true,
      supportsTemplates: true,
      hasSessionWindow: true,
      sessionWindowHours: WHATSAPP_SESSION_WINDOW_HOURS,
    };
  }

  /**
   * Verifica o evento bruto ANTES de qualquer efeito (Req 6.3–6.6).
   *
   *  - GET (handshake): `true` sse `hub.mode = "subscribe"` E
   *    `hub.verify_token` confere EXATAMENTE com o segredo. (O route handler
   *    ecoa `hub.challenge` no sucesso.)
   *  - POST: valida `x-hub-signature-256` = `sha256=<hex>` via HMAC-SHA256 do
   *    `rawBody` com o `app_secret`, em comparação de tempo constante.
   *    Ausência/invalidez ⇒ `false`.
   *
   * A `secretRef` vem da query (`__secretRef`) ou do header, permitindo ao
   * route handler informar qual conta está sendo verificada. Nunca loga o
   * valor do segredo.
   */
  async verifyInbound(req: RawRequest): Promise<boolean> {
    const secretRef = this.extractSecretRef(req);
    if (!secretRef) {
      return false;
    }

    let secrets: WhatsAppSecrets;
    try {
      secrets = await this.resolveSecrets(secretRef);
    } catch {
      // Falha ao resolver segredo ⇒ não verificado (sem vazar detalhes).
      return false;
    }

    if (req.method.toUpperCase() === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      if (mode !== "subscribe" || typeof token !== "string") {
        return false;
      }
      return constantTimeEqualHex(token, secrets.verifyToken);
    }

    // POST — verificação HMAC do corpo bruto exato.
    const header = req.headers["x-hub-signature-256"];
    if (typeof header !== "string" || !header.startsWith("sha256=")) {
      return false;
    }
    const expected =
      "sha256=" +
      createHmac("sha256", secrets.appSecret)
        .update(req.rawBody, "utf8")
        .digest("hex");
    return constantTimeEqualHex(header, expected);
  }

  /**
   * Normaliza o payload do webhook da Meta em `InboundMessage[]`.
   *
   * Resolve a conta (tenant) por `phone_number_id`. Se a conta não for
   * resolvida, as mensagens daquele número são DESCARTADAS (o `IngestionRouter`
   * também protege o tenant). Mídia recebida guarda o `media id` em `mediaRef`
   * (o download acontece depois, em outro componente).
   */
  async parseInbound(req: RawRequest): Promise<InboundMessage[]> {
    let payload: unknown;
    try {
      payload = JSON.parse(req.rawBody);
    } catch {
      return [];
    }

    const entries = this.readArray(payload, "entry");
    const result: InboundMessage[] = [];

    for (const entry of entries) {
      const changes = this.readArray(entry, "changes");
      for (const change of changes) {
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
          // Conta desconhecida ⇒ descartar (tenant não resolvido).
          continue;
        }

        // Mapa wa_id -> nome de contato (quando presente).
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
          const from = typeof message.from === "string" ? message.from : undefined;
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
          const body = extractBody(message);
          if (body !== undefined) {
            inbound.body = body;
          }
          const mediaRef = extractMediaRef(metaType, message);
          if (mediaRef !== undefined) {
            inbound.mediaRef = mediaRef;
          }

          result.push(inbound);
        }
      }
    }

    return result;
  }

  /**
   * Envia uma `OutboundMessage` pela conta informada.
   *
   * REGRA DA JANELA DE 24h (Req 6.8 / Property 9): fora da janela
   * (`windowExpiresAt` nulo ou `< agora`) e SEM `templateName`, o envio é
   * REJEITADO ANTES de qualquer chamada à Cloud API, retornando um
   * `SendResult` com `accepted: false` e `error` explicativo (a
   * `OutboundMessage` é preservada como não enviada). Dentro da janela,
   * formato livre é permitido; templates são sempre permitidos.
   *
   * Quando permitido, faz `POST` a
   * `https://graph.facebook.com/v21.0/{phoneNumberId}/messages` com
   * `Authorization: Bearer {accessToken}` e corpo conforme a spec da Meta.
   * Retorna `{ externalId: <messages[0].id>, accepted: true }`. Em erro HTTP,
   * retorna `{ externalId: "", accepted: false, error }`.
   */
  async send(
    account: ChannelAccountRef,
    msg: OutboundMessage,
  ): Promise<SendResult> {
    const hasTemplate =
      typeof msg.templateName === "string" && msg.templateName.length > 0;

    // 1) Guarda da janela de 24h — ANTES de resolver segredos ou chamar a API.
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

    // 2) Resolver segredos (nunca logados) e o phone_number_id.
    let secrets: WhatsAppSecrets;
    try {
      secrets = await this.resolveSecrets(account.secretRef);
    } catch {
      return {
        externalId: "",
        accepted: false,
        error: `Falha ao resolver segredos para secretRef=${account.secretRef}.`,
      };
    }

    const phoneNumberId =
      secrets.phoneNumberId ?? account.externalId ?? undefined;
    if (!phoneNumberId) {
      return {
        externalId: "",
        accepted: false,
        error: "phone_number_id ausente (secret/ChannelAccount.externalId).",
      };
    }

    // 3) Montar corpo conforme a spec da Meta (text | template | mídia por link).
    const body = this.buildSendBody(msg, hasTemplate);

    // 4) POST para a Cloud API oficial (graph.facebook.com) via fetch nativo.
    const url = `${CLOUD_API_BASE}/${encodeURIComponent(phoneNumberId)}/messages`;
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secrets.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        // NÃO logamos accessToken/appSecret; apenas status/detalhe da API.
        let detail = "";
        try {
          detail = await response.text();
        } catch {
          detail = "";
        }
        return {
          externalId: "",
          accepted: false,
          error: `Cloud API HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        };
      }

      const json = (await response.json()) as {
        messages?: Array<{ id?: string }>;
      };
      const externalId = json.messages?.[0]?.id ?? "";
      return { externalId, accepted: true };
    } catch (err) {
      return {
        externalId: "",
        accepted: false,
        error: err instanceof Error ? err.message : "Erro de rede na Cloud API.",
      };
    }
  }

  /**
   * Monta o corpo do POST `/messages` conforme a spec da Meta.
   *  - template: objeto `template` com nome, idioma e parâmetros de corpo.
   *  - mídia por link (IMAGE/DOCUMENT/AUDIO/VIDEO com `mediaRef` em URL): usa
   *    o objeto de mídia com `link` (ou `id` quando não é URL). Isto roteia
   *    genuinamente por `graph.facebook.com` (não simulado).
   *  - texto: objeto `text` com `body`.
   */
  private buildSendBody(
    msg: OutboundMessage,
    hasTemplate: boolean,
  ): Record<string, unknown> {
    const to = msg.conversationId; // no wiring real, resolvido para o wa_id do contato.

    if (hasTemplate) {
      const components = msg.templateParams
        ? [
            {
              type: "body",
              parameters: Object.values(msg.templateParams).map((text) => ({
                type: "text",
                text,
              })),
            },
          ]
        : undefined;
      return {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: msg.templateName,
          language: { code: "pt_BR" },
          ...(components ? { components } : {}),
        },
      };
    }

    const mediaType = this.mediaKind(msg.type);
    if (mediaType && msg.mediaRef) {
      const isLink = /^https?:\/\//i.test(msg.mediaRef);
      const mediaObject = isLink
        ? { link: msg.mediaRef }
        : { id: msg.mediaRef };
      return {
        messaging_product: "whatsapp",
        to,
        type: mediaType,
        [mediaType]: {
          ...mediaObject,
          ...(msg.body ? { caption: msg.body } : {}),
        },
      };
    }

    return {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: msg.body ?? "" },
    };
  }

  /** Mapeia `MessageType` do domínio para a chave de mídia da Meta. */
  private mediaKind(type: MessageType): string | undefined {
    switch (type) {
      case MessageType.IMAGE:
        return "image";
      case MessageType.DOCUMENT:
        return "document";
      case MessageType.AUDIO:
        return "audio";
      case MessageType.VIDEO:
        return "video";
      default:
        return undefined;
    }
  }

  /**
   * Extrai a `secretRef` da requisição bruta. Preferimos a query
   * (`__secretRef`) — informada pelo route handler — e, em fallback, um header
   * dedicado. Nunca é o valor do segredo, apenas a referência.
   */
  private extractSecretRef(req: RawRequest): string | undefined {
    const fromQuery = req.query["__secretRef"];
    if (typeof fromQuery === "string" && fromQuery.length > 0) {
      return fromQuery;
    }
    const fromHeader = req.headers["x-channel-secret-ref"];
    if (typeof fromHeader === "string" && fromHeader.length > 0) {
      return fromHeader;
    }
    return undefined;
  }

  // -- Helpers de leitura defensiva do JSON não confiável do webhook. --

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
 * Fábrica do adaptador Cloud. O wiring da aplicação passa um `SecretResolver`
 * que lê de env/secret manager; os testes injetam stubs. Mantém o núcleo
 * livre de `process.env`.
 */
export function createWhatsAppCloudAdapter(
  deps: WhatsAppCloudAdapterDeps,
): WhatsAppCloudAdapter {
  return new WhatsAppCloudAdapter(deps);
}
