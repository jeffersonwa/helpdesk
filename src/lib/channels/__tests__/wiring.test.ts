/**
 * Testes do wiring/resolvedor de segredos por env — tarefa 21.1/21.2.
 *
 * Exercitam as fábricas puras do `wiring.ts` com `env`/`prisma` INJETADOS
 * (sem tocar `process.env` real, banco ou rede):
 *   - resolvedor de segredos do WhatsApp por `secretRef` (env);
 *   - resolvedores DB de conta/janela (fake prisma);
 *   - verificador de assinatura de e-mail (token compartilhado);
 *   - verificador de CAPTCHA (fail-closed sem provedor);
 *   - autenticador de API por Bearer token (hash → userId → SessionUser);
 *   - resolvedor de token de formulário público.
 */

import { createHash, createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ChannelConfigError,
  createDbAccountResolver,
  createDbFormTokenResolver,
  createDbWindowResolver,
  createEnvApiTokenAuthenticator,
  createEnvCaptchaVerifier,
  createEnvEmailSignatureVerifier,
  createEnvWhatsAppSecretResolver,
  defaultWhatsAppSecretRef,
} from "@/lib/channels/wiring";
import type { RawRequest } from "@/lib/channels/adapter";

const WA_ENV = {
  WHATSAPP_APP_SECRET: "app-secret",
  WHATSAPP_VERIFY_TOKEN: "verify",
  WHATSAPP_ACCESS_TOKEN: "access",
  WHATSAPP_PHONE_NUMBER_ID: "PN-1",
};

describe("createEnvWhatsAppSecretResolver", () => {
  it("resolve os segredos do secretRef padrão a partir do env", async () => {
    const resolve = createEnvWhatsAppSecretResolver(WA_ENV);
    const secrets = await resolve(defaultWhatsAppSecretRef(WA_ENV));
    expect(secrets).toMatchObject({
      appSecret: "app-secret",
      verifyToken: "verify",
      accessToken: "access",
      phoneNumberId: "PN-1",
    });
  });

  it("lança ChannelConfigError para secretRef desconhecido", async () => {
    const resolve = createEnvWhatsAppSecretResolver(WA_ENV);
    await expect(resolve("whatsapp:outro")).rejects.toBeInstanceOf(
      ChannelConfigError,
    );
  });

  it("lança quando variáveis obrigatórias estão ausentes", async () => {
    const resolve = createEnvWhatsAppSecretResolver({});
    await expect(resolve(defaultWhatsAppSecretRef({}))).rejects.toBeInstanceOf(
      ChannelConfigError,
    );
  });
});

describe("resolvedores DB (fake prisma)", () => {
  it("createDbAccountResolver mapeia phone_number_id → conta", async () => {
    const findFirst = vi.fn(async () => ({ id: "acc-1", companyId: "c1" }));
    const prisma = { channelAccount: { findFirst } } as never;
    const resolve = createDbAccountResolver(prisma);
    const acc = await resolve("PN-1");
    expect(acc).toEqual({ id: "acc-1", companyId: "c1" });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("createDbAccountResolver → null quando não encontra", async () => {
    const prisma = {
      channelAccount: { findFirst: async () => null },
    } as never;
    expect(await createDbAccountResolver(prisma)("PN-x")).toBeNull();
  });

  it("createDbWindowResolver lê Conversation.windowExpiresAt", async () => {
    const when = new Date("2026-01-01T00:00:00.000Z");
    const prisma = {
      conversation: { findUnique: async () => ({ windowExpiresAt: when }) },
    } as never;
    expect(await createDbWindowResolver(prisma)("conv-1")).toEqual(when);
  });

  it("createDbWindowResolver → null quando não há janela", async () => {
    const prisma = {
      conversation: { findUnique: async () => null },
    } as never;
    expect(await createDbWindowResolver(prisma)("conv-x")).toBeNull();
  });

  it("createDbFormTokenResolver mapeia token → tenant", async () => {
    const prisma = {
      channelAccount: {
        findFirst: async () => ({ id: "acc-form", companyId: "c1" }),
      },
    } as never;
    expect(await createDbFormTokenResolver(prisma)("tok")).toEqual({
      channelAccountId: "acc-form",
      companyId: "c1",
    });
  });

  it("createDbFormTokenResolver → null para token vazio (sem consultar)", async () => {
    const findFirst = vi.fn();
    const prisma = { channelAccount: { findFirst } } as never;
    expect(await createDbFormTokenResolver(prisma)("")).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("createEnvEmailSignatureVerifier", () => {
  const mkReq = (token?: string): RawRequest => ({
    method: "POST",
    headers: token ? { "x-webhook-token": token } : {},
    query: {},
    rawBody: "{}",
  });

  it("token correto → true", () => {
    const verify = createEnvEmailSignatureVerifier({
      RESEND_WEBHOOK_SECRET: "s3cr3t",
    });
    expect(verify(mkReq("s3cr3t"))).toBe(true);
  });

  it("token incorreto → false", () => {
    const verify = createEnvEmailSignatureVerifier({
      RESEND_WEBHOOK_SECRET: "s3cr3t",
    });
    expect(verify(mkReq("errado"))).toBe(false);
  });

  it("sem secret configurado → false (fail-closed)", () => {
    const verify = createEnvEmailSignatureVerifier({});
    expect(verify(mkReq("qualquer"))).toBe(false);
  });

  // --- Assinatura Svix (padrão do Resend) ---
  const svixSecretB64 = Buffer.from("chave-super-secreta-svix").toString("base64");
  const svixSecret = `whsec_${svixSecretB64}`;

  function svixReq(body: string, ts: number, sign = true, id = "msg_123"): RawRequest {
    const key = Buffer.from(svixSecretB64, "base64");
    const signed = `${id}.${ts}.${body}`;
    const sig = createHmac("sha256", key).update(signed, "utf8").digest("base64");
    return {
      method: "POST",
      headers: {
        "svix-id": id,
        "svix-timestamp": String(ts),
        "svix-signature": sign ? `v1,${sig}` : "v1,assinatura-errada",
      },
      query: {},
      rawBody: body,
    };
  }

  it("Svix: assinatura válida dentro da janela → true", () => {
    const verify = createEnvEmailSignatureVerifier({ RESEND_WEBHOOK_SECRET: svixSecret });
    const now = Math.floor(Date.now() / 1000);
    expect(verify(svixReq('{"from":"a@b.com"}', now))).toBe(true);
  });

  it("Svix: assinatura inválida → false", () => {
    const verify = createEnvEmailSignatureVerifier({ RESEND_WEBHOOK_SECRET: svixSecret });
    const now = Math.floor(Date.now() / 1000);
    expect(verify(svixReq('{"from":"a@b.com"}', now, false))).toBe(false);
  });

  it("Svix: timestamp fora da janela (replay) → false", () => {
    const verify = createEnvEmailSignatureVerifier({ RESEND_WEBHOOK_SECRET: svixSecret });
    const old = Math.floor(Date.now() / 1000) - 60 * 60; // 1h atrás
    expect(verify(svixReq('{"from":"a@b.com"}', old))).toBe(false);
  });

  it("Svix: corpo adulterado → false", () => {
    const verify = createEnvEmailSignatureVerifier({ RESEND_WEBHOOK_SECRET: svixSecret });
    const now = Math.floor(Date.now() / 1000);
    const req = svixReq('{"from":"a@b.com"}', now);
    req.rawBody = '{"from":"atacante@b.com"}'; // muda o corpo após assinar
    expect(verify(req)).toBe(false);
  });
});

describe("createEnvCaptchaVerifier", () => {
  it("sem provedor e modo padrão → fail-closed (false)", async () => {
    const verify = createEnvCaptchaVerifier({});
    expect(await verify("tok")).toBe(false);
  });

  it("sem provedor e PUBLIC_FORM_CAPTCHA_MODE=disabled → true (dev)", async () => {
    const verify = createEnvCaptchaVerifier({
      PUBLIC_FORM_CAPTCHA_MODE: "disabled",
    });
    expect(await verify("tok")).toBe(true);
  });

  it("token vazio → false", async () => {
    const verify = createEnvCaptchaVerifier({
      PUBLIC_FORM_CAPTCHA_MODE: "disabled",
    });
    expect(await verify("")).toBe(false);
  });

  it("Turnstile configurado → chama siteverify e retorna success", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true }),
    })) as unknown as typeof fetch;
    const verify = createEnvCaptchaVerifier(
      { TURNSTILE_SECRET_KEY: "k" },
      fetchImpl,
    );
    expect(await verify("tok")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createEnvApiTokenAuthenticator", () => {
  const TOKEN = "super-secret-token";
  const HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");

  function fakePrisma(user: unknown) {
    return { user: { findUnique: async () => user } } as never;
  }

  it("sem header Authorization → não autenticado", async () => {
    const auth = createEnvApiTokenAuthenticator({
      env: { API_TOKENS: JSON.stringify({ [HASH]: "u1" }) },
      prisma: fakePrisma(null),
    });
    expect(await auth(undefined)).toEqual({ authenticated: false });
  });

  it("token desconhecido → não autenticado", async () => {
    const auth = createEnvApiTokenAuthenticator({
      env: { API_TOKENS: JSON.stringify({ [HASH]: "u1" }) },
      prisma: fakePrisma(null),
    });
    expect(await auth("Bearer outro-token")).toEqual({
      authenticated: false,
    });
  });

  it("token válido + usuário existente → autenticado com SessionUser", async () => {
    const auth = createEnvApiTokenAuthenticator({
      env: { API_TOKENS: JSON.stringify({ [HASH]: "u1" }) },
      prisma: fakePrisma({
        id: "u1",
        companyId: "c1",
        role: "SERVICE_ACCOUNT",
        roleAssignments: [
          {
            roleDef: { permissions: [{ action: "ticket.create" }] },
            scopes: [{ level: "TENANT", refId: null }],
          },
        ],
      }),
    });
    const ctx = await auth(`Bearer ${TOKEN}`);
    expect(ctx.authenticated).toBe(true);
    if (ctx.authenticated) {
      expect(ctx.companyId).toBe("c1");
      expect(ctx.user.roleAssignments[0]!.permissions).toContain("ticket.create");
    }
  });

  it("token válido mas usuário inexistente → não autenticado", async () => {
    const auth = createEnvApiTokenAuthenticator({
      env: { API_TOKENS: JSON.stringify({ [HASH]: "u1" }) },
      prisma: fakePrisma(null),
    });
    expect(await auth(`Bearer ${TOKEN}`)).toEqual({ authenticated: false });
  });
});
