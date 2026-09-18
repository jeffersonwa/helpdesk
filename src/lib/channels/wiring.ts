/**
 * Wiring de canais + resolvedor de segredos por `secretRef` (tarefa 21.1).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seções "Fluxo de Integração WhatsApp Business Cloud API" e
 * "Adapter real vs. mock") e requisitos 5, 6, 8, 9.
 *
 * ------------------------------------------------------------------------
 * PAPEL
 * ------------------------------------------------------------------------
 * Este módulo é a ÚNICA camada que lê `process.env` para os canais. Ele
 * transforma configuração de ambiente em dependências injetáveis puras que os
 * adaptadores (WhatsApp Cloud/Mock, Email) e o intake do formulário público
 * consomem. Assim:
 *   - os adaptadores permanecem livres de `process.env` (testáveis e seguros);
 *   - os route handlers apenas montam `RawRequest` e delegam;
 *   - segredos NUNCA são embutidos no código — apenas resolvidos em runtime.
 *
 * ------------------------------------------------------------------------
 * RESOLUÇÃO DE SEGREDOS DO WHATSAPP (Req 6.1–6.6, 17.3)
 * ------------------------------------------------------------------------
 * A `ChannelAccount.secretRef` é uma REFERÊNCIA a um segredo (nunca o valor).
 * A implementação mínima suporta UMA conta padrão via variáveis de ambiente:
 *
 *   WHATSAPP_APP_SECRET        → HMAC do `X-Hub-Signature-256` (POST)
 *   WHATSAPP_VERIFY_TOKEN      → handshake GET (`hub.verify_token`)
 *   WHATSAPP_ACCESS_TOKEN      → Bearer para chamadas à Cloud API
 *   WHATSAPP_PHONE_NUMBER_ID   → `phone_number_id` (opcional; também via conta)
 *
 * A `secretRef` convencional da conta padrão é `WHATSAPP_DEFAULT_SECRET_REF`
 * (padrão: {@link DEFAULT_WHATSAPP_SECRET_REF}). Qualquer `secretRef` igual a
 * ela resolve para o conjunto de env acima.
 *
 * COMO ESTENDER PARA MULTI-TENANT (per-tenant secret store):
 *   Substitua {@link createEnvWhatsAppSecretResolver} por um resolvedor que,
 *   dado o `secretRef` (ex.: `secret://whatsapp/<companyId>`), consulte um
 *   secret manager (AWS Secrets Manager, Vault, etc.) e devolva
 *   `WhatsAppSecrets`. Nenhum outro código muda: o resolvedor é injetado.
 *   Um esquema simples baseado em env por conta também é possível, prefixando
 *   as variáveis com o slug da conta (ex.: `WHATSAPP__ACME__APP_SECRET`) e
 *   derivando o prefixo do `secretRef`.
 */

import type {
  ChannelAdapter,
  ChannelAccountRef,
} from "@/lib/channels/adapter";
import {
  createWhatsAppCloudAdapter,
  type AccountResolver,
  type SecretResolver,
  type WhatsAppSecrets,
  type WindowResolver,
} from "@/lib/channels/whatsapp/cloud-adapter";
import { createWhatsAppMockAdapter } from "@/lib/channels/whatsapp/mock-adapter";
import {
  assertMockAllowed,
  resolveWhatsAppProvider,
} from "@/lib/channels/registry";
import { ChannelProvider, ChannelType } from "@/lib/domain";
import { prisma as defaultPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";

type Env = Record<string, string | undefined>;

/** `secretRef` convencional da conta WhatsApp padrão (single-account via env). */
export const DEFAULT_WHATSAPP_SECRET_REF = "whatsapp:default" as const;

/**
 * Erro de configuração ausente. Lançado quando um `secretRef` não pode ser
 * resolvido a partir do ambiente. NUNCA inclui o valor de segredos — apenas o
 * `secretRef` (referência) e a variável ausente.
 */
export class ChannelConfigError extends Error {
  readonly code = "CHANNEL_CONFIG_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChannelConfigError";
    Object.setPrototypeOf(this, ChannelConfigError.prototype);
  }
}

/**
 * Retorna o `secretRef` da conta WhatsApp padrão configurada no ambiente.
 * O route handler usa isto na verificação GET quando nenhum `__secretRef`
 * explícito é informado.
 */
export function defaultWhatsAppSecretRef(env: Env = process.env): string {
  const configured = env.WHATSAPP_DEFAULT_SECRET_REF?.trim();
  return configured && configured.length > 0
    ? configured
    : DEFAULT_WHATSAPP_SECRET_REF;
}

/**
 * Cria um {@link SecretResolver} de WhatsApp baseado em variáveis de ambiente
 * (single-account). Lê os segredos APENAS quando chamado (lazy) e nunca os
 * loga. Para o `secretRef` padrão, resolve das 4 variáveis documentadas.
 *
 * Se um `secretRef` desconhecido for solicitado, lança {@link ChannelConfigError}
 * — o adaptador trata isso como "não verificado" (retorna `false`), sem vazar
 * detalhes.
 */
export function createEnvWhatsAppSecretResolver(
  env: Env = process.env,
): SecretResolver {
  const defaultRef = defaultWhatsAppSecretRef(env);

  return async (secretRef: string): Promise<WhatsAppSecrets> => {
    if (secretRef !== defaultRef) {
      throw new ChannelConfigError(
        `secretRef desconhecido (esperado "${defaultRef}"). ` +
          `Configure um secret store per-tenant para múltiplas contas.`,
      );
    }

    const appSecret = env.WHATSAPP_APP_SECRET;
    const verifyToken = env.WHATSAPP_VERIFY_TOKEN;
    const accessToken = env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;

    const missing: string[] = [];
    if (!appSecret) missing.push("WHATSAPP_APP_SECRET");
    if (!verifyToken) missing.push("WHATSAPP_VERIFY_TOKEN");
    if (!accessToken) missing.push("WHATSAPP_ACCESS_TOKEN");
    if (missing.length > 0) {
      throw new ChannelConfigError(
        `Configuração de WhatsApp ausente para secretRef="${secretRef}": ` +
          `${missing.join(", ")}.`,
      );
    }

    const secrets: WhatsAppSecrets = {
      appSecret: appSecret as string,
      verifyToken: verifyToken as string,
      accessToken: accessToken as string,
    };
    if (phoneNumberId && phoneNumberId.length > 0) {
      secrets.phoneNumberId = phoneNumberId;
    }
    return secrets;
  };
}

/** Prisma mínimo usado pelos resolvedores DB-backed. */
export type WiringPrisma = Pick<
  PrismaClient,
  "channelAccount" | "conversation"
>;

/**
 * {@link AccountResolver} respaldado pelo banco: dado um `phone_number_id`,
 * busca a `ChannelAccount` do tipo WHATSAPP ativa cujo `externalId` bate.
 * Retorna `null` quando não existe conta correspondente — o adaptador então
 * DESCARTA as mensagens daquele número (Req 5.5/10.8).
 */
export function createDbAccountResolver(
  prisma: WiringPrisma = defaultPrisma as unknown as WiringPrisma,
): AccountResolver {
  return async (phoneNumberId: string) => {
    const account = await prisma.channelAccount.findFirst({
      where: {
        type: ChannelType.WHATSAPP,
        externalId: phoneNumberId,
        active: true,
      },
      select: { id: true, companyId: true },
    });
    return account ? { id: account.id, companyId: account.companyId } : null;
  };
}

/**
 * {@link WindowResolver} respaldado pelo banco: lê `Conversation.windowExpiresAt`
 * pelo id da conversa (janela de 24h do WhatsApp). Retorna `null` quando não há
 * janela aberta (envio fora da janela exige template — Req 6.8).
 */
export function createDbWindowResolver(
  prisma: WiringPrisma = defaultPrisma as unknown as WiringPrisma,
): WindowResolver {
  return async (conversationId: string) => {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { windowExpiresAt: true },
    });
    return conversation?.windowExpiresAt ?? null;
  };
}

/**
 * Constrói o {@link ChannelAdapter} de WhatsApp selecionado pelo ambiente:
 *   - `WHATSAPP_CLOUD` → {@link WhatsAppCloudAdapter} com resolvedor de segredo
 *     por env + resolvedores DB (conta/janela);
 *   - `WHATSAPP_MOCK`  → {@link WhatsAppMockAdapter} (bloqueado em produção via
 *     `assertMockAllowed`).
 *
 * `env`/`prisma` são injetáveis para testes; os padrões usam `process.env` e o
 * `prisma` compartilhado.
 */
export function buildWhatsAppAdapter(opts: {
  env?: Env;
  prisma?: WiringPrisma;
} = {}): ChannelAdapter {
  const env = opts.env ?? process.env;
  const prisma = opts.prisma ?? (defaultPrisma as unknown as WiringPrisma);
  const provider = resolveWhatsAppProvider(env);

  if (provider === ChannelProvider.WHATSAPP_MOCK) {
    // Guarda inviolável: lança se NODE_ENV === "production".
    assertMockAllowed(env);
    return createWhatsAppMockAdapter({
      env,
      resolveAccount: createDbAccountResolver(prisma),
      resolveWindow: createDbWindowResolver(prisma),
    });
  }

  return createWhatsAppCloudAdapter({
    resolveSecrets: createEnvWhatsAppSecretResolver(env),
    resolveAccount: createDbAccountResolver(prisma),
    resolveWindow: createDbWindowResolver(prisma),
  });
}

/**
 * Constrói uma {@link ChannelAccountRef} para a conta WhatsApp padrão do
 * ambiente, usada por rotinas de ENVIO na borda (o recebimento resolve a conta
 * por `phone_number_id`). Sem `phone_number_id` configurado, `externalId` é
 * nulo (o adaptador então falha o envio com erro claro).
 */
export function defaultWhatsAppAccountRef(
  companyId: string,
  env: Env = process.env,
): ChannelAccountRef {
  const externalId = env.WHATSAPP_PHONE_NUMBER_ID ?? null;
  return {
    id: `whatsapp-default-${companyId}`,
    companyId,
    type: ChannelType.WHATSAPP,
    provider: ChannelProvider.WHATSAPP_CLOUD,
    externalId,
    secretRef: defaultWhatsAppSecretRef(env),
  };
}

// ===========================================================================
// E-MAIL (v2) — verificação de assinatura do provedor (Req 7.1/7.2)
// ===========================================================================

import { timingSafeEqual as nodeTimingSafeEqual, createHash } from "node:crypto";

import type { RawRequest } from "@/lib/channels/adapter";
import {
  createEmailAdapter,
  type EmailAdapter,
  type ResolveAccountByAddress,
  type SendEmailParams,
  type VerifyProviderSignature,
} from "@/lib/channels/email/adapter";

/**
 * Comparação de tempo constante de dois tokens (strings). Buffers de tamanhos
 * diferentes NÃO vazam o tamanho do segredo: comparamos hashes de tamanho fixo
 * antes de retornar `false`.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    const ha = createHash("sha256").update(bufA).digest();
    const hb = createHash("sha256").update(bufB).digest();
    nodeTimingSafeEqual(ha, hb);
    return false;
  }
  return nodeTimingSafeEqual(bufA, bufB);
}

/**
 * Cria um {@link VerifyProviderSignature} para o webhook de e-mail (estilo
 * Resend). A implementação mínima valida um TOKEN compartilhado enviado no
 * header `x-webhook-token` (ou query `token`) contra `RESEND_WEBHOOK_SECRET`,
 * em tempo constante.
 *
 * Sem `RESEND_WEBHOOK_SECRET` configurado ⇒ fail-closed (`false`): o endpoint
 * NÃO aceita nada, evitando criação de tickets por qualquer origem.
 *
 * COMO ESTENDER: para verificação HMAC do corpo bruto (assinatura do provedor
 * sobre `rawBody`), substitua por uma função que recomputa o HMAC do
 * `req.rawBody` com o segredo e compara com o header — mantendo a mesma
 * assinatura injetável.
 */
export function createEnvEmailSignatureVerifier(
  env: Env = process.env,
): VerifyProviderSignature {
  const secret = env.RESEND_WEBHOOK_SECRET;
  return (req: RawRequest): boolean => {
    if (!secret) {
      // Fail-closed: sem segredo, nada é aceito.
      return false;
    }
    const token =
      req.headers["x-webhook-token"] ?? req.query["token"] ?? "";
    if (typeof token !== "string" || token.length === 0) {
      return false;
    }
    return constantTimeEqual(token, secret);
  };
}

/**
 * {@link ResolveAccountByAddress} respaldado pelo banco: mapeia o endereço de
 * destino (mailbox) para a `ChannelAccount` EMAIL ativa via `externalId`.
 */
export function createDbEmailAccountResolver(
  prisma: WiringPrisma = defaultPrisma as unknown as WiringPrisma,
): ResolveAccountByAddress {
  return async (toAddress: string) => {
    const normalized = toAddress.trim().toLowerCase();
    const account = await prisma.channelAccount.findFirst({
      where: {
        type: ChannelType.EMAIL,
        externalId: normalized,
        active: true,
      },
      select: { id: true, companyId: true },
    });
    return account ? { id: account.id, companyId: account.companyId } : null;
  };
}

/**
 * Constrói o {@link EmailAdapter} oficial (v2) em modo webhook (`EMAIL_RESEND`)
 * com o verificador de assinatura por env e o resolvedor de conta por endereço.
 * O envio real (`sendEmail`) é injetado pelo worker de resposta (tarefa 23); a
 * borda de ingestão só precisa de `verifyInbound`/`parseInbound`.
 */
export function buildEmailAdapter(opts: {
  env?: Env;
  prisma?: WiringPrisma;
  sendEmail?: (params: SendEmailParams) => Promise<{ id: string }>;
} = {}): EmailAdapter {
  const env = opts.env ?? process.env;
  const prisma = opts.prisma ?? (defaultPrisma as unknown as WiringPrisma);
  return createEmailAdapter({
    provider: ChannelProvider.EMAIL_RESEND,
    verifyProviderSignature: createEnvEmailSignatureVerifier(env),
    resolveAccountByAddress: createDbEmailAccountResolver(prisma),
    // Envio não é exercido na ingestão; padrão inócuo se não injetado.
    sendEmail:
      opts.sendEmail ??
      (async () => {
        throw new ChannelConfigError(
          "Envio de e-mail não configurado nesta borda (use o worker de resposta).",
        );
      }),
  });
}

// ===========================================================================
// FORMULÁRIO PÚBLICO — captcha + resolução de token (Req 8.3/8.6)
// ===========================================================================

import {
  createRateLimiter,
  createMemoryRateLimitStore,
  type InjectableRateLimiter,
  type RateLimitStore,
} from "@/lib/rate-limit";
import type { ResolvedFormToken } from "@/lib/channels/public-form/adapter";

/**
 * Store de rate limit compartilhado do processo para o formulário público.
 * Mantê-lo em módulo garante que as janelas persistam entre requisições no
 * mesmo processo (single-instance). Em serverless multi-instância, troque por
 * um store Redis via {@link createRateLimiter}.
 */
let sharedPublicFormStore: RateLimitStore | undefined;

/** Retorna o rate limiter injetável do formulário público (store de processo). */
export function getPublicFormRateLimiter(): InjectableRateLimiter {
  if (!sharedPublicFormStore) {
    sharedPublicFormStore = createMemoryRateLimitStore();
  }
  return createRateLimiter({ store: sharedPublicFormStore });
}

/**
 * Cria a função `verifyCaptcha` verificada no SERVIDOR (Req 8.3).
 *
 * - Se um provedor está configurado (`TURNSTILE_SECRET_KEY` ou
 *   `RECAPTCHA_SECRET_KEY`), faz POST ao endpoint `siteverify` correspondente
 *   e retorna `success`.
 * - Se NENHUM provedor está configurado, comporta-se de forma SEGURA e
 *   DOCUMENTADA conforme `PUBLIC_FORM_CAPTCHA_MODE`:
 *     - ausente ou `"required"` (padrão) ⇒ fail-closed: sempre `false`
 *       (o formulário fica indisponível até configurar o CAPTCHA);
 *     - `"disabled"` ⇒ aceita (SOMENTE para desenvolvimento local; NÃO use em
 *       produção — deixe o CAPTCHA obrigatório).
 */
export function createEnvCaptchaVerifier(
  env: Env = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): (token: string) => Promise<boolean> {
  const turnstileSecret = env.TURNSTILE_SECRET_KEY;
  const recaptchaSecret = env.RECAPTCHA_SECRET_KEY;

  return async (token: string): Promise<boolean> => {
    if (typeof token !== "string" || token.length === 0) {
      return false;
    }

    if (turnstileSecret) {
      return verifySiteVerify(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        turnstileSecret,
        token,
        fetchImpl,
      );
    }
    if (recaptchaSecret) {
      return verifySiteVerify(
        "https://www.google.com/recaptcha/api/siteverify",
        recaptchaSecret,
        token,
        fetchImpl,
      );
    }

    // Nenhum provedor configurado: fail-closed por padrão (Req 8.3/8.4).
    return env.PUBLIC_FORM_CAPTCHA_MODE === "disabled";
  };
}

/** POST `application/x-www-form-urlencoded` a um endpoint `siteverify`. */
async function verifySiteVerify(
  url: string,
  secret: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const params = new URLSearchParams();
    params.set("secret", secret);
    params.set("response", token);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) {
      return false;
    }
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    // Falha de rede ⇒ não verificado (fail-closed).
    return false;
  }
}

/**
 * Resolve um TOKEN público de formulário → `{ channelAccountId, companyId }`
 * (Req 8.6/8.7). O token é armazenado como o `secretRef` de uma
 * `ChannelAccount` do tipo PUBLIC_FORM ativa (convenção: `public-form:<token>`),
 * de modo que o mapeamento token→conta é 1:1 e não revela o tenant.
 *
 * Retorna `null` para token inválido/ausente/inativo — a borda responde de
 * forma genérica (404) sem revelar detalhes.
 */
export function createDbFormTokenResolver(
  prisma: WiringPrisma = defaultPrisma as unknown as WiringPrisma,
): (token: string) => Promise<ResolvedFormToken | null> {
  return async (token: string) => {
    if (typeof token !== "string" || token.length === 0) {
      return null;
    }
    const account = await prisma.channelAccount.findFirst({
      where: {
        type: ChannelType.PUBLIC_FORM,
        secretRef: `public-form:${token}`,
        active: true,
      },
      select: { id: true, companyId: true },
    });
    return account
      ? { channelAccountId: account.id, companyId: account.companyId }
      : null;
  };
}

// ===========================================================================
// API (v1) — autenticação por Bearer token → ApiAuthContext (Req 9.1/9.2)
// ===========================================================================

import { createHash as nodeCreateHash } from "node:crypto";

import type { ApiAuthContext } from "@/lib/channels/api/adapter";
import type { SessionUser, RoleScope, RoleAssignment } from "@/lib/domain/types";
import { Role, ScopeLevel } from "@/lib/domain";

/** Prisma mínimo para resolver o service account do token. */
export type ApiAuthPrisma = Pick<PrismaClient, "user">;

/**
 * Resolve um Bearer token → {@link ApiAuthContext} (Req 9.1/9.2).
 *
 * ESQUEMA MÍNIMO E DOCUMENTADO (sem alterar o schema):
 *   - Os tokens ficam FORA do código, na variável `API_TOKENS` (env), como um
 *     JSON que mapeia o SHA-256 (hex) do token → id do usuário de
 *     integração/serviço:
 *         API_TOKENS={"<sha256hex(token)>":"<userId>"}
 *     Armazenamos apenas o HASH — o token em claro nunca vai a env/log.
 *   - O `userId` resolvido é buscado no banco (DB-backed) para obter
 *     `companyId`, `role` e `roleAssignments`, montando o `SessionUser` que o
 *     `Authorization.assert` do TicketService consome. O tenant vem SEMPRE do
 *     servidor (a conta), nunca do payload.
 *
 * COMO ESTENDER: substitua por uma tabela `ApiToken(tokenHash, userId, companyId,
 * expiresAt)` e faça o lookup por hash — a assinatura injetável não muda.
 *
 * Retorna `{ authenticated: false }` quando o header está ausente/mal-formado,
 * o token não mapeia a nenhum usuário, ou o usuário não existe (⇒ 401).
 */
export function createEnvApiTokenAuthenticator(opts: {
  env?: Env;
  prisma?: ApiAuthPrisma;
} = {}): (authorizationHeader: string | null | undefined) => Promise<ApiAuthContext> {
  const env = opts.env ?? process.env;
  const prisma = opts.prisma ?? (defaultPrisma as unknown as ApiAuthPrisma);

  return async (authorizationHeader) => {
    const token = extractBearer(authorizationHeader);
    if (!token) {
      return { authenticated: false };
    }

    const map = parseApiTokens(env.API_TOKENS);
    const tokenHash = nodeCreateHash("sha256").update(token, "utf8").digest("hex");
    const userId = map[tokenHash];
    if (!userId) {
      return { authenticated: false };
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        companyId: true,
        role: true,
        roleAssignments: {
          select: {
            roleDef: { select: { permissions: { select: { action: true } } } },
            scopes: { select: { level: true, refId: true } },
          },
        },
      },
    });
    if (!user) {
      return { authenticated: false };
    }

    const roleAssignments: RoleAssignment[] = user.roleAssignments.map((ra) => ({
      permissions: ra.roleDef?.permissions.map((p) => p.action) ?? [],
      scopes: ra.scopes.map(
        (s): RoleScope => ({
          level: s.level as ScopeLevel,
          refId: s.refId ?? null,
        }),
      ),
    }));

    const sessionUser: SessionUser = {
      id: user.id,
      companyId: user.companyId,
      role: user.role as Role,
      roleAssignments,
    };

    return {
      authenticated: true,
      companyId: user.companyId,
      user: sessionUser,
    };
  };
}

/** Extrai o token de um header `Authorization: Bearer <token>`. */
function extractBearer(header: string | null | undefined): string | null {
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/** Lê o mapa `API_TOKENS` (JSON hash→userId). Inválido/ausente ⇒ vazio. */
function parseApiTokens(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) {
          out[k] = v;
        }
      }
      return out;
    }
  } catch {
    // JSON inválido ⇒ nenhum token válido (fail-closed).
  }
  return {};
}
