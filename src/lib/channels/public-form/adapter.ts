/**
 * `PublicFormAdapter` — intake seguro de um formulário público SEM autenticação
 * de usuário. Canal INBOUND-ONLY: não envia mensagens de saída.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Segurança do Formulário Público") e Requisito 8.
 *
 * ------------------------------------------------------------------------
 * REGRAS INVIOLÁVEIS (Req 8)
 * ------------------------------------------------------------------------
 * A submissão é endurecida e as verificações são aplicadas NESTA ORDEM:
 *   1. Rate limiting (Req 8.1/8.2): ≤5/IP/min E ≤20/`ChannelAccount`/min.
 *      Exceder ⇒ `RateLimitError` (429), nada persistido.
 *   2. CAPTCHA (Req 8.3/8.4): verificado no servidor ANTES de qualquer
 *      persistência. Falha ⇒ `CaptchaError`, nada persistido.
 *   3. Antispam (Req 8.5/8.8): honeypot (campo isca) ⇒ `HoneypotError`
 *      (rejeição silenciosa como spam); validação estrita com Zod ⇒
 *      `PublicFormValidationError`. Sem PII em log.
 *   4. Escopo de tenant (Req 8.6/8.7): derivado de um TOKEN público de
 *      formulário mapeado para uma `ChannelAccount` — NUNCA do corpo. Token
 *      inválido/ausente/expirado ⇒ `InvalidFormTokenError`, sem revelar
 *      detalhes do tenant.
 *   5. Sucesso: produz um `InboundMessage` normalizado (companyId +
 *      channelAccountId do TOKEN) que o `IngestionRouter` consome.
 *
 * `companyId`/`channelAccountId` JAMAIS vêm do corpo — sempre do token.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

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
import type { InjectableRateLimiter } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// Erros tipados
// ---------------------------------------------------------------------------

/** Erro base do formulário público — carrega um `status` HTTP sugerido. */
export abstract class PublicFormError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Rate limit excedido (Req 8.2) — 429. */
export class RateLimitError extends PublicFormError {
  readonly code = "rate_limited";
  readonly status = 429;
  constructor(message = "Limite de submissões excedido. Tente novamente em instantes.") {
    super(message);
  }
}

/** Falha na verificação de CAPTCHA (Req 8.4) — 400. */
export class CaptchaError extends PublicFormError {
  readonly code = "captcha_failed";
  readonly status = 400;
  constructor(message = "Falha na verificação de CAPTCHA.") {
    super(message);
  }
}

/**
 * Honeypot acionado (Req 8.5). Tratado como SPAM: rejeição silenciosa.
 * `status` 200 propositalmente para não sinalizar a bots que foram detectados.
 */
export class HoneypotError extends PublicFormError {
  readonly code = "spam_detected";
  readonly status = 200;
  constructor(message = "Submissão descartada.") {
    super(message);
  }
}

/**
 * Token de formulário inválido/ausente/expirado (Req 8.7). Mensagem genérica:
 * NÃO revela detalhes do tenant.
 */
export class InvalidFormTokenError extends PublicFormError {
  readonly code = "invalid_form_token";
  readonly status = 404;
  constructor(message = "Formulário indisponível.") {
    super(message);
  }
}

/** Validação Zod do payload falhou (Req 8.8). 422. Sem PII na mensagem. */
export class PublicFormValidationError extends PublicFormError {
  readonly code = "invalid_payload";
  readonly status = 422;
  /** Campos inválidos (apenas nomes/motivos — NUNCA valores/PII). */
  readonly fields: Array<{ field: string; reason: string }>;
  constructor(fields: Array<{ field: string; reason: string }>) {
    super("Dados da submissão inválidos.");
    this.fields = fields;
  }
}

// ---------------------------------------------------------------------------
// Validação Zod estrita do payload (Req 8.5/8.8)
// ---------------------------------------------------------------------------

/**
 * Payload público visível ao usuário. Limites sensatos e alinhados aos demais
 * canais (título/assunto 1–200, mensagem 1–5.000). `email` validado.
 */
export const publicFormPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().min(3).max(254).email(),
    subject: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(5000),
  })
  .strict();

export type PublicFormPayload = z.infer<typeof publicFormPayloadSchema>;

// ---------------------------------------------------------------------------
// Entrada e dependências injetadas
// ---------------------------------------------------------------------------

/** Nome padrão do campo honeypot (campo isca oculto no formulário). */
export const DEFAULT_HONEYPOT_FIELD = "website";

/** Resultado da resolução de um token de formulário para o tenant/conta. */
export interface ResolvedFormToken {
  channelAccountId: string;
  companyId: string;
}

/** Dependências injetáveis (todas necessárias para testabilidade pura). */
export interface PublicFormDeps {
  /** Limitador injetável (relógio/store mockáveis). */
  rateLimiter: InjectableRateLimiter;
  /** Verifica o token de CAPTCHA no servidor (Req 8.3). */
  verifyCaptcha: (token: string) => Promise<boolean>;
  /**
   * Resolve o TOKEN público → `{ channelAccountId, companyId }` (Req 8.6).
   * Retorna `null` para token inválido/ausente/expirado (Req 8.7).
   */
  resolveFormToken: (token: string) => Promise<ResolvedFormToken | null>;
  /** Relógio injetável para o timestamp da mensagem. Padrão: `Date.now`. */
  now?: () => number;
  /** Gerador de id externo. Padrão: `crypto.randomUUID`. */
  generateId?: () => string;
  /** Nome do campo honeypot. Padrão: `DEFAULT_HONEYPOT_FIELD`. */
  honeypotField?: string;
}

/** Entrada da submissão pública. */
export interface PublicFormSubmission {
  /** Token público que define o tenant (NÃO vem do corpo de negócio). */
  formToken: string | null | undefined;
  /** IP do submissor (para rate limiting por IP). */
  ip: string;
  /** Token de CAPTCHA a verificar no servidor. */
  captchaToken: string;
  /** Campos de negócio + honeypot (validados/filtrados aqui). */
  payload: Record<string, unknown>;
}

// Limites do Req 8.1.
const MAX_PER_IP_PER_MIN = 5;
const MAX_PER_ACCOUNT_PER_MIN = 20;
const ONE_MINUTE_MS = 60_000;

/**
 * Executa o intake seguro do formulário público. Aplica as verificações do
 * Req 8 NA ORDEM especificada e, em sucesso, devolve um `InboundMessage`
 * normalizado com o tenant derivado do TOKEN (não do corpo).
 *
 * Lança um subtipo de `PublicFormError` em qualquer rejeição. NUNCA registra
 * PII (nome/e-mail/assunto/mensagem) em log.
 */
export async function submitPublicForm(
  input: PublicFormSubmission,
  deps: PublicFormDeps,
): Promise<InboundMessage> {
  const now = deps.now ?? (() => Date.now());
  const generateId = deps.generateId ?? (() => randomUUID());
  const honeypotField = deps.honeypotField ?? DEFAULT_HONEYPOT_FIELD;

  // --- 1. Rate limiting (Req 8.1/8.2) --------------------------------------
  // Por IP e por token de formulário (proxy da ChannelAccount antes de
  // resolver o token — evita resolver/persistir sob abuso). A verificação
  // por conta usa o token como chave, pois o mapeamento token→conta é 1:1.
  const ipKey = `public-form:ip:${input.ip}`;
  const ip = deps.rateLimiter.check(ipKey, MAX_PER_IP_PER_MIN, ONE_MINUTE_MS);
  if (!ip.allowed) {
    throw new RateLimitError();
  }

  const tokenKey = `public-form:token:${input.formToken ?? "∅"}`;
  const acc = deps.rateLimiter.check(
    tokenKey,
    MAX_PER_ACCOUNT_PER_MIN,
    ONE_MINUTE_MS,
  );
  if (!acc.allowed) {
    throw new RateLimitError();
  }

  // --- 2. CAPTCHA (Req 8.3/8.4) — ANTES de qualquer persistência -----------
  const captchaOk =
    typeof input.captchaToken === "string" &&
    input.captchaToken.length > 0 &&
    (await deps.verifyCaptcha(input.captchaToken));
  if (!captchaOk) {
    throw new CaptchaError();
  }

  // --- 3. Antispam: honeypot + validação Zod estrita (Req 8.5/8.8) ---------
  const rawPayload = input.payload ?? {};
  const honeypotValue = rawPayload[honeypotField];
  if (typeof honeypotValue === "string" && honeypotValue.trim().length > 0) {
    // Honeypot preenchido ⇒ bot. Rejeição silenciosa como spam (sem PII).
    throw new HoneypotError();
  }

  // Valida APENAS os campos de negócio conhecidos (name/email/subject/message).
  // O corpo bruto pode conter campos de transporte legítimos (honeypot,
  // captchaToken) e o schema é `.strict()`, então extraímos os campos de
  // negócio antes de validar — mantendo a rejeição de campos extras entre os
  // campos de negócio (Req 8.5/8.8) sem confundir com metadados de transporte.
  const businessPayload = {
    name: rawPayload["name"],
    email: rawPayload["email"],
    subject: rawPayload["subject"],
    message: rawPayload["message"],
  };
  const parsed = publicFormPayloadSchema.safeParse(businessPayload);
  if (!parsed.success) {
    // Apenas nomes de campo + motivo — NUNCA os valores (evita PII em log).
    const fields = parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "(payload)",
      reason: issue.code,
    }));
    throw new PublicFormValidationError(fields);
  }
  const data = parsed.data;

  // --- 4. Escopo de tenant do TOKEN (Req 8.6/8.7) — nunca do corpo ---------
  const token = input.formToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new InvalidFormTokenError();
  }
  const resolved = await deps.resolveFormToken(token);
  if (!resolved) {
    // Inválido/ausente/expirado — mensagem genérica, sem revelar tenant.
    throw new InvalidFormTokenError();
  }

  // --- 5. Sucesso: InboundMessage normalizado ------------------------------
  const inbound: InboundMessage = {
    companyId: resolved.companyId,
    channelAccountId: resolved.channelAccountId,
    contactExternalId: data.email,
    contactName: data.name,
    type: MessageType.TEXT,
    body: data.message,
    externalId: `public-form-${generateId()}`,
    timestamp: new Date(now()),
  };
  return inbound;
}

// ---------------------------------------------------------------------------
// ChannelAdapter (consistência com o modelo de canais — inbound-only)
// ---------------------------------------------------------------------------

/**
 * `PublicFormAdapter` implementa a interface `ChannelAdapter` para manter a
 * consistência do modelo de canais. O canal é INBOUND-ONLY:
 *  - `send` retorna um `SendResult` NÃO aceito (o formulário não envia saída);
 *  - `verifyInbound`/`parseInbound` do fluxo bruto delegam ao `submitPublicForm`
 *    via os helpers do adaptador — o intake real e testável é `submitPublicForm`.
 */
export class PublicFormAdapter implements ChannelAdapter {
  readonly type = ChannelType.PUBLIC_FORM;
  readonly provider = ChannelProvider.INTERNAL;

  private readonly deps: PublicFormDeps;

  constructor(deps: PublicFormDeps) {
    this.deps = deps;
  }

  capabilities(): ChannelCapabilities {
    return {
      supportsMedia: false,
      supportsTemplates: false,
      hasSessionWindow: false,
    };
  }

  /**
   * O formulário público não usa assinatura de provedor; a "verificação" real
   * (rate limit/CAPTCHA/honeypot/token) ocorre em `submitPublicForm`. Aqui
   * apenas confirmamos que há corpo a processar.
   */
  async verifyInbound(req: RawRequest): Promise<boolean> {
    return req.method.toUpperCase() === "POST" && req.rawBody.length > 0;
  }

  /**
   * Normaliza uma submissão bruta em zero ou um `InboundMessage`, delegando ao
   * `submitPublicForm`. O token vem do cabeçalho/query (nunca do corpo).
   */
  async parseInbound(req: RawRequest): Promise<InboundMessage[]> {
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      throw new PublicFormValidationError([
        { field: "(payload)", reason: "invalid_json" },
      ]);
    }

    const formToken =
      req.headers["x-form-token"] ?? req.query["token"] ?? undefined;
    const captchaToken =
      req.headers["x-captcha-token"] ??
      (typeof body["captchaToken"] === "string"
        ? (body["captchaToken"] as string)
        : "");
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
      req.headers["x-real-ip"] ??
      "unknown";

    const message = await submitPublicForm(
      { formToken, ip, captchaToken, payload: body },
      this.deps,
    );
    return [message];
  }

  /** Inbound-only: o formulário público NÃO envia mensagens de saída. */
  async send(
    _account: ChannelAccountRef,
    _msg: OutboundMessage,
  ): Promise<SendResult> {
    return {
      externalId: "",
      accepted: false,
      error: "PublicFormAdapter é inbound-only: envio de saída não suportado.",
    };
  }
}

/** Fábrica do adaptador de formulário público. */
export function createPublicFormAdapter(deps: PublicFormDeps): PublicFormAdapter {
  return new PublicFormAdapter(deps);
}
