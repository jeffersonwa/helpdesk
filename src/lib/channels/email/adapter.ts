/**
 * `EmailAdapter` — canal de e-mail (Req. 7).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Fluxo de Ingestão por E-mail") e requirements 7.1–7.7.
 *
 * ------------------------------------------------------------------------
 * Duas estratégias INTERCAMBIÁVEIS atrás do mesmo adaptador (design):
 * ------------------------------------------------------------------------
 *  1. Inbound Webhook (provider estilo Resend): o provedor faz POST para
 *     `/api/webhooks/email` com a mensagem já parseada; a autenticidade é
 *     verificada pela ASSINATURA do provedor (`verifyInbound`).
 *  2. IMAP polling (nodemailer/imap): um worker busca a caixa e converte cada
 *     e-mail. NÃO há assinatura de webhook nesse caminho — a "verificação"
 *     acontece pela conexão/credenciais IMAP (autenticadas no cliente IMAP
 *     injetado). `verifyInbound` retorna `false` para requisições de webhook
 *     quando o provider está em modo IMAP, porque o IMAP não recebe webhooks.
 *
 * PRINCÍPIOS (iguais ao WhatsAppCloudAdapter):
 *  - Núcleo PURO em relação ao ambiente: nada de `process.env`, nenhuma
 *    dependência real de IMAP/SMTP/HTTP. Tudo é INJETADO
 *    (verificador de assinatura, resolvedor de conta, cliente IMAP, enviador
 *    de e-mail, relógio) — o que torna o adaptador testável e seguro por
 *    construção.
 *  - `InboundMessage`, `OutboundMessage`, `ChannelCapabilities`, `SendResult`
 *    vêm do domínio (`@/lib/domain`) — nunca redefinidos aqui.
 *  - Idempotência via `externalId = Message-ID` do e-mail
 *    (`@@unique([companyId, externalId])`), tratada pelo `IngestionRouter`.
 *
 * _Requisitos: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
 */

import type {
  ChannelAccountRef,
  ChannelAdapter,
  RawRequest,
} from "@/lib/channels/adapter";
import { ChannelProvider, ChannelType, MessageType } from "@/lib/domain";
import type {
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "@/lib/domain";

/** Intervalo de polling IMAP: limites do requisito 7.3 (segundos). */
export const IMAP_POLL_MIN_SECONDS = 30 as const;
export const IMAP_POLL_MAX_SECONDS = 300 as const;
export const IMAP_POLL_DEFAULT_SECONDS = 60 as const;

/** Número máximo de tentativas de busca IMAP (Req. 7.4). */
export const IMAP_MAX_ATTEMPTS = 3 as const;

// ---------------------------------------------------------------------------
// Erros tipados
// ---------------------------------------------------------------------------

/**
 * Falha de verificação de assinatura do provedor de webhook (Req. 7.2).
 * A borda registra a indicação de falha; nenhuma `InboundMessage` é criada.
 */
export class EmailSignatureError extends Error {
  readonly code = "EMAIL_SIGNATURE_INVALID" as const;
  constructor(message = "Assinatura de e-mail inválida ou ausente") {
    super(message);
    this.name = "EmailSignatureError";
    Object.setPrototypeOf(this, EmailSignatureError.prototype);
  }
}

/**
 * Falha de busca IMAP após esgotar as tentativas (Req. 7.4).
 * Carrega a quantidade de tentativas e o último erro (indicação de erro).
 */
export class ImapFetchError extends Error {
  readonly code = "IMAP_FETCH_FAILED" as const;
  readonly attempts: number;
  constructor(attempts: number, cause?: unknown) {
    super(`Falha ao buscar e-mails via IMAP após ${attempts} tentativa(s)`);
    this.name = "ImapFetchError";
    this.attempts = attempts;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
    Object.setPrototypeOf(this, ImapFetchError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Tipos de entrada bruta e dependências injetadas
// ---------------------------------------------------------------------------

/**
 * E-mail bruto, já parseado, como o cliente IMAP entrega ao adaptador.
 * Espelha os campos mínimos do webhook parseado — os dois caminhos convergem
 * na mesma normalização `toInboundMessage`.
 */
export interface RawEmail {
  /** `Message-ID` — base da idempotência (`externalId`). */
  messageId: string;
  /** Endereço do remetente (usado como `contactExternalId`). */
  from: string;
  /** Nome de exibição do remetente, se presente. */
  fromName?: string;
  /** Endereço de destino (mailbox) — resolve tenant/ChannelAccount. */
  to: string;
  subject?: string;
  /** Corpo em texto puro (preferido). */
  text?: string;
  /** Corpo em HTML (usado como fallback, com tags removidas). */
  html?: string;
  /** Cabeçalho `In-Reply-To`, se resposta a um e-mail anterior (Req. 7.5). */
  inReplyTo?: string;
  /** Cabeçalho `References`, cadeia de thread (Req. 7.5). */
  references?: string[];
  /** Referências de anexos (mantidas em `mediaRef`, mensagem continua TEXT). */
  attachments?: Array<{ id?: string; filename?: string }>;
  /** Data do e-mail; ausente → o adaptador usa o relógio injetado. */
  date?: Date;
}

/**
 * Verifica a assinatura do provedor de webhook (estilo Resend). Injetado:
 * a implementação real valida o header de assinatura do provedor contra o
 * segredo (resolvido de `secretRef`); os testes injetam um stub.
 * Retorna `true` sse a assinatura confere; `false` caso contrário/ausente.
 */
export type VerifyProviderSignature = (req: RawRequest) => boolean;

/**
 * Resolve `ChannelAccount` (tenant) a partir do endereço de destino
 * (mailbox), análogo ao `phone_number_id` do WhatsApp. Retorna `null` quando
 * o endereço não pertence a nenhum tenant conhecido → mensagem DESCARTADA.
 */
export type ResolveAccountByAddress = (
  toAddress: string,
) => Promise<{ id: string; companyId: string } | null>;

/**
 * Interface MÍNIMA de cliente IMAP — deliberadamente sem dependência real de
 * `imap`. O wiring real (worker, task 23) injeta um cliente concreto; os
 * testes injetam um stub. Só precisamos buscar as mensagens não lidas.
 */
export interface ImapClient {
  fetchUnseen(): Promise<RawEmail[]>;
}

/** Parâmetros de envio de e-mail, agnósticos ao provedor (Resend/nodemailer). */
export interface SendEmailParams {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  /** Cabeçalhos de thread preservados na resposta (Req. 7.7). */
  inReplyTo?: string;
  references?: string[];
}

/**
 * Envia um e-mail via provedor abstrato (Resend/nodemailer). Injetado.
 * Retorna o id atribuído pelo provedor (vira `SendResult.externalId`).
 */
export type SendEmail = (params: SendEmailParams) => Promise<{ id: string }>;

/** Dependências injetadas do `EmailAdapter`. */
export interface EmailAdapterDeps {
  /** `EMAIL_RESEND` (webhook) ou `EMAIL_IMAP` (polling). */
  provider: ChannelProvider.EMAIL_RESEND | ChannelProvider.EMAIL_IMAP;
  /** Verificador de assinatura do webhook (obrigatório no modo Resend). */
  verifyProviderSignature?: VerifyProviderSignature;
  /** Resolve tenant/ChannelAccount pelo endereço de destino. */
  resolveAccountByAddress: ResolveAccountByAddress;
  /** Enviador de e-mail (resposta do agente com thread). */
  sendEmail: SendEmail;
  /** Intervalo de polling IMAP em segundos (30–300; padrão 60). */
  pollIntervalSeconds?: number;
  /** Relógio injetável. Padrão: `Date.now`. */
  now?: () => number;
}

/** Dependências de uma execução única de polling IMAP. */
export interface PollImapDeps {
  imap: ImapClient;
  /** Máximo de tentativas na falha de busca (padrão {@link IMAP_MAX_ATTEMPTS}). */
  maxAttempts?: number;
}

/** Resultado de `pollOnce`: mensagens normalizadas + tentativas realizadas. */
export interface PollResult {
  messages: InboundMessage[];
  attempts: number;
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

/** Normaliza o intervalo de polling ao range permitido (30–300s). */
function clampInterval(seconds: number | undefined): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return IMAP_POLL_DEFAULT_SECONDS;
  }
  if (seconds < IMAP_POLL_MIN_SECONDS) {
    return IMAP_POLL_MIN_SECONDS;
  }
  if (seconds > IMAP_POLL_MAX_SECONDS) {
    return IMAP_POLL_MAX_SECONDS;
  }
  return Math.floor(seconds);
}

/** Remove tags HTML de forma conservadora, para derivar corpo textual. */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

/** Extrai nome de exibição de um header `From` como `"Fulano <a@b.com>"`. */
function parseDisplayName(from: string): string | undefined {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  if (match && match[1]) {
    const name = match[1].trim();
    return name.length > 0 ? name : undefined;
  }
  return undefined;
}

/** Extrai o endereço "puro" de um header `From` como `"Fulano <a@b.com>"`. */
function parseAddress(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  if (match && match[1]) {
    return match[1].trim();
  }
  return from.trim();
}

// ---------------------------------------------------------------------------
// EmailAdapter
// ---------------------------------------------------------------------------

/**
 * `EmailAdapter` — implementação de `ChannelAdapter` para o canal de e-mail,
 * com providers `EMAIL_RESEND` (webhook) e `EMAIL_IMAP` (polling).
 */
export class EmailAdapter implements ChannelAdapter {
  readonly type = ChannelType.EMAIL;
  readonly provider: ChannelProvider.EMAIL_RESEND | ChannelProvider.EMAIL_IMAP;

  private readonly verifyProviderSignature?: VerifyProviderSignature;
  private readonly resolveAccountByAddress: ResolveAccountByAddress;
  private readonly sendEmail: SendEmail;
  private readonly now: () => number;
  /** Intervalo de polling IMAP normalizado (config exposta). */
  readonly pollIntervalSeconds: number;

  constructor(deps: EmailAdapterDeps) {
    this.provider = deps.provider;
    this.verifyProviderSignature = deps.verifyProviderSignature;
    this.resolveAccountByAddress = deps.resolveAccountByAddress;
    this.sendEmail = deps.sendEmail;
    this.now = deps.now ?? (() => Date.now());
    this.pollIntervalSeconds = clampInterval(deps.pollIntervalSeconds);
  }

  /**
   * Capacidades do canal de e-mail: suporta mídia (anexos), sem templates,
   * sem janela de sessão (Req. 7 — e-mail não tem janela de 24h).
   */
  capabilities(): ChannelCapabilities {
    return {
      supportsMedia: true,
      supportsTemplates: false,
      hasSessionWindow: false,
    };
  }

  /**
   * Verifica o evento bruto ANTES de qualquer efeito (Req. 7.1, 7.2).
   *
   *  - Modo Resend (webhook): valida a assinatura do provedor via
   *    `verifyProviderSignature`. Ausente/inválida ⇒ `false` (nenhuma
   *    `InboundMessage` deve ser criada). Verificador não configurado ⇒
   *    `false` (fail-closed).
   *  - Modo IMAP: NÃO há assinatura de webhook — o caminho IMAP é verificado
   *    pela conexão/credenciais no `pollOnce`. Um webhook em modo IMAP não é
   *    esperado, então retornamos `false` (fail-closed).
   */
  async verifyInbound(req: RawRequest): Promise<boolean> {
    if (this.provider === ChannelProvider.EMAIL_IMAP) {
      // Sem webhook no modo IMAP: a verificação é por conexão/credenciais.
      return false;
    }
    if (!this.verifyProviderSignature) {
      return false;
    }
    try {
      return this.verifyProviderSignature(req) === true;
    } catch {
      return false;
    }
  }

  /**
   * Normaliza um e-mail recebido via webhook em `InboundMessage[]` (Req. 7.1).
   *
   * O corpo do webhook (`req.rawBody`) é um JSON com o e-mail parseado pelo
   * provedor. Resolve o tenant/ChannelAccount pelo endereço de destino
   * (`resolveAccountByAddress`); se não resolver, DESCARTA (lista vazia).
   *
   * SEGURANÇA: `parseInbound` NÃO reverifica a assinatura — a borda chama
   * `verifyInbound` antes. Ainda assim, é defensivo contra JSON malformado.
   */
  async parseInbound(req: RawRequest): Promise<InboundMessage[]> {
    let payload: unknown;
    try {
      payload = JSON.parse(req.rawBody);
    } catch {
      return [];
    }

    const raw = this.readRawEmail(payload);
    if (!raw) {
      return [];
    }

    const inbound = await this.toInboundMessage(raw);
    return inbound ? [inbound] : [];
  }

  /**
   * Envia a resposta do agente ao solicitante original PRESERVANDO os
   * cabeçalhos de thread (`In-Reply-To`/`References`) — Req. 7.7.
   *
   * A `OutboundMessage` carrega as informações de thread via `templateParams`
   * (mapa string→string) para manter a forma de `OutboundMessage` inalterada:
   *   - `to`         → endereço do solicitante original
   *   - `from`       → endereço da caixa (ChannelAccount)
   *   - `subject`    → assunto (idealmente `Re: ...`)
   *   - `inReplyTo`  → `Message-ID` do e-mail original
   *   - `references` → cadeia de `References` separada por espaço
   *
   * Em sucesso retorna `{ externalId: providerId, accepted: true }`; em erro
   * `{ externalId: "", accepted: false, error }` (mensagem preservada como não
   * enviada).
   */
  async send(
    account: ChannelAccountRef,
    msg: OutboundMessage,
  ): Promise<SendResult> {
    const params = msg.templateParams ?? {};
    const to = params.to;
    if (!to) {
      return {
        externalId: "",
        accepted: false,
        error: "Destinatário (to) ausente para resposta de e-mail.",
      };
    }
    const from = params.from ?? account.externalId ?? "";
    const subject = params.subject ?? "";
    const references = params.references
      ? params.references.split(/\s+/).filter((r) => r.length > 0)
      : undefined;

    const sendParams: SendEmailParams = {
      to,
      from,
      subject,
      ...(msg.body !== undefined ? { text: msg.body } : {}),
      ...(params.inReplyTo ? { inReplyTo: params.inReplyTo } : {}),
      ...(references && references.length > 0 ? { references } : {}),
    };

    try {
      const result = await this.sendEmail(sendParams);
      return { externalId: result.id, accepted: true };
    } catch (err) {
      return {
        externalId: "",
        accepted: false,
        error: err instanceof Error ? err.message : "Falha ao enviar e-mail.",
      };
    }
  }

  /**
   * Executa UMA rodada de polling IMAP (Req. 7.3, 7.4).
   *
   * Busca as mensagens não lidas com até `maxAttempts` tentativas (padrão 3);
   * na falha de TODAS, lança {@link ImapFetchError} (indicação de erro). Em
   * sucesso, converte cada `RawEmail` em `InboundMessage` (descartando os que
   * não resolvem tenant) e retorna o resultado + tentativas realizadas.
   *
   * O AGENDAMENTO periódico (a cada `pollIntervalSeconds`) pertence ao worker
   * (task 23); aqui expomos apenas a execução única.
   */
  async pollOnce(deps: PollImapDeps): Promise<PollResult> {
    const maxAttempts = deps.maxAttempts ?? IMAP_MAX_ATTEMPTS;
    let lastError: unknown;
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const emails = await deps.imap.fetchUnseen();
        const messages: InboundMessage[] = [];
        for (const raw of emails) {
          const inbound = await this.toInboundMessage(raw);
          if (inbound) {
            messages.push(inbound);
          }
        }
        return { messages, attempts };
      } catch (err) {
        lastError = err;
      }
    }

    // Todas as tentativas falharam → indicação de erro (Req. 7.4).
    throw new ImapFetchError(attempts, lastError);
  }

  // -- Internos --------------------------------------------------------------

  /**
   * Converte um `RawEmail` (webhook ou IMAP) em `InboundMessage`.
   * Resolve tenant/ChannelAccount pelo endereço de destino; sem correspondência
   * → `null` (descartado). Anexos mantêm a mensagem como TEXT e guardam a
   * referência do primeiro anexo em `mediaRef` (Req. 7 — corpo continua TEXT).
   */
  private async toInboundMessage(
    raw: RawEmail,
  ): Promise<InboundMessage | null> {
    if (!raw.messageId || !raw.from || !raw.to) {
      return null;
    }

    const account = await this.resolveAccountByAddress(raw.to);
    if (!account) {
      // Endereço não mapeado a nenhum tenant → descartar.
      return null;
    }

    const contactExternalId = parseAddress(raw.from);
    const contactName = raw.fromName ?? parseDisplayName(raw.from);

    // Corpo: texto puro preferido; fallback para HTML sem tags.
    let body: string | undefined;
    if (typeof raw.text === "string" && raw.text.length > 0) {
      body = raw.text;
    } else if (typeof raw.html === "string" && raw.html.length > 0) {
      body = stripHtml(raw.html);
    }

    const timestamp = raw.date ?? new Date(this.now());

    const inbound: InboundMessage = {
      companyId: account.companyId,
      channelAccountId: account.id,
      contactExternalId,
      // `externalId = Message-ID` → idempotência/thread pelo router (Req. 7.5).
      externalId: raw.messageId,
      // Anexos NÃO mudam o tipo: o corpo do e-mail permanece TEXT.
      type: MessageType.TEXT,
      timestamp,
    };

    if (contactName !== undefined) {
      inbound.contactName = contactName;
    }
    if (body !== undefined) {
      inbound.body = body;
    }
    // Referência de anexo (quando houver) — mensagem continua TEXT.
    const firstAttachment = raw.attachments?.find(
      (a) => typeof a.id === "string" && a.id.length > 0,
    );
    if (firstAttachment?.id) {
      inbound.mediaRef = firstAttachment.id;
    }

    return inbound;
  }

  /**
   * Lê defensivamente o `RawEmail` do JSON não confiável do webhook.
   * Aceita tanto o formato "achatado" quanto um envelope `{ email: {...} }`.
   */
  private readRawEmail(payload: unknown): RawEmail | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const root = payload as Record<string, unknown>;
    const node =
      root.email && typeof root.email === "object"
        ? (root.email as Record<string, unknown>)
        : root;

    const messageId = this.readString(node, ["messageId", "message_id", "id"]);
    const from = this.readString(node, ["from", "sender"]);
    const to = this.readString(node, ["to", "recipient"]);
    if (!messageId || !from || !to) {
      return null;
    }

    const raw: RawEmail = { messageId, from, to };

    const fromName = this.readString(node, ["fromName", "from_name"]);
    if (fromName) {
      raw.fromName = fromName;
    }
    const subject = this.readString(node, ["subject"]);
    if (subject) {
      raw.subject = subject;
    }
    const text = this.readString(node, ["text", "text_body", "plain"]);
    if (text) {
      raw.text = text;
    }
    const html = this.readString(node, ["html", "html_body"]);
    if (html) {
      raw.html = html;
    }
    const inReplyTo = this.readString(node, ["inReplyTo", "in_reply_to"]);
    if (inReplyTo) {
      raw.inReplyTo = inReplyTo;
    }
    const references = node.references ?? node.reference;
    if (Array.isArray(references)) {
      raw.references = references.filter(
        (r): r is string => typeof r === "string",
      );
    } else if (typeof references === "string" && references.length > 0) {
      raw.references = references.split(/\s+/).filter((r) => r.length > 0);
    }
    if (Array.isArray(node.attachments)) {
      raw.attachments = node.attachments
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => {
          const att: { id?: string; filename?: string } = {};
          if (typeof a.id === "string") att.id = a.id;
          if (typeof a.filename === "string") att.filename = a.filename;
          return att;
        });
    }
    return raw;
  }

  /** Lê a primeira chave presente como string não vazia. */
  private readString(
    node: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = node[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }
}

/**
 * Fábrica do `EmailAdapter`. O wiring da aplicação seleciona o provider
 * (`EMAIL_RESEND`/`EMAIL_IMAP`) e injeta os resolvedores/enviador reais; os
 * testes injetam stubs. Mantém o núcleo livre de `process.env` e de I/O real.
 */
export function createEmailAdapter(deps: EmailAdapterDeps): EmailAdapter {
  return new EmailAdapter(deps);
}
