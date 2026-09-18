/**
 * Testes unitários do `PublicFormAdapter` / `submitPublicForm` (Task 19.2).
 *
 * Cobrem, com dependências injetadas (relógio/store do limitador, mock de
 * `verifyCaptcha` e `resolveFormToken`), os cenários do Req 8:
 *   - rate limit excedido por IP e por conta → RateLimitError (429), sem persistir;
 *   - CAPTCHA falho → CaptchaError, sem persistir;
 *   - honeypot acionado → HoneypotError (spam);
 *   - token inválido/ausente/expirado → InvalidFormTokenError, sem revelar tenant;
 *   - payload inválido (Zod) → PublicFormValidationError, sem PII em log;
 *   - happy path → InboundMessage bem formado com tenant do TOKEN (não do corpo).
 *
 * Testes 100% puros — sem DB, sem rede.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CaptchaError,
  HoneypotError,
  InvalidFormTokenError,
  PublicFormValidationError,
  RateLimitError,
  submitPublicForm,
  createPublicFormAdapter,
  type PublicFormDeps,
  type ResolvedFormToken,
} from "@/lib/channels/public-form/adapter";
import { ChannelProvider, ChannelType, MessageType } from "@/lib/domain";
import {
  createMemoryRateLimitStore,
  createRateLimiter,
} from "@/lib/rate-limit";

// --- Constantes de teste -----------------------------------------------------

const VALID_TOKEN = "tok_valid";
const TENANT: ResolvedFormToken = {
  channelAccountId: "acct-123",
  companyId: "company-777",
};

// PII fictícia usada nos testes — o payload de negócio NUNCA deve vazar em log.
const PII = {
  name: "Fulano de Tal",
  email: "fulano@exemplo.com",
  subject: "Preciso de ajuda com login",
  message: "Não consigo acessar minha conta desde ontem à noite.",
};

// --- Helpers para montar deps injetadas -------------------------------------

interface HarnessOptions {
  now?: () => number;
  store?: ReturnType<typeof createMemoryRateLimitStore>;
  verifyCaptcha?: (token: string) => Promise<boolean>;
  resolveFormToken?: (token: string) => Promise<ResolvedFormToken | null>;
}

function makeDeps(opts: HarnessOptions = {}): PublicFormDeps & {
  captchaSpy: ReturnType<typeof vi.fn>;
  resolveSpy: ReturnType<typeof vi.fn>;
} {
  const store = opts.store ?? createMemoryRateLimitStore();
  const now = opts.now ?? (() => 1_000_000);
  const rateLimiter = createRateLimiter({ store, now });

  const captchaSpy = vi.fn(
    opts.verifyCaptcha ?? (async () => true),
  );
  const resolveSpy = vi.fn(
    opts.resolveFormToken ??
      (async (token: string) => (token === VALID_TOKEN ? TENANT : null)),
  );

  return {
    rateLimiter,
    verifyCaptcha: captchaSpy as unknown as PublicFormDeps["verifyCaptcha"],
    resolveFormToken:
      resolveSpy as unknown as PublicFormDeps["resolveFormToken"],
    now,
    generateId: () => "fixed-id",
    captchaSpy,
    resolveSpy,
  };
}

function validSubmission(overrides: Record<string, unknown> = {}) {
  return {
    formToken: VALID_TOKEN,
    ip: "203.0.113.10",
    captchaToken: "captcha-abc",
    payload: { ...PII },
    ...overrides,
  };
}

// --- Happy path --------------------------------------------------------------

describe("submitPublicForm — happy path (Req 8.6)", () => {
  it("retorna InboundMessage bem formado com tenant derivado do TOKEN, não do corpo", async () => {
    const deps = makeDeps();
    // O tenant vem do TOKEN; o corpo (name/email/subject/message) não carrega
    // tenant. Confirmamos que companyId/channelAccountId são os do token.
    const msg = await submitPublicForm(validSubmission(), deps);

    expect(msg.companyId).toBe(TENANT.companyId);
    expect(msg.channelAccountId).toBe(TENANT.channelAccountId);
    expect(msg.companyId).not.toBe("ATACANTE");
    expect(msg.channelAccountId).not.toBe("ATACANTE");
    expect(msg.contactExternalId).toBe(PII.email);
    expect(msg.contactName).toBe(PII.name);
    expect(msg.type).toBe(MessageType.TEXT);
    expect(msg.body).toBe(PII.message);
    expect(msg.externalId).toBe("public-form-fixed-id");
    expect(msg.timestamp).toBeInstanceOf(Date);
    expect(deps.captchaSpy).toHaveBeenCalledTimes(1);
    expect(deps.resolveSpy).toHaveBeenCalledWith(VALID_TOKEN);
  });
});

// --- Rate limiting -----------------------------------------------------------

describe("submitPublicForm — rate limiting (Req 8.1/8.2)", () => {
  it("excede o limite por IP (5/min) → RateLimitError, nada persistido", async () => {
    const store = createMemoryRateLimitStore();
    const deps = makeDeps({ store });

    // 5 submissões OK do MESMO IP.
    for (let i = 0; i < 5; i++) {
      await expect(submitPublicForm(validSubmission(), deps)).resolves.toEqual(
        expect.objectContaining({ companyId: TENANT.companyId }),
      );
    }

    // 6ª do mesmo IP → 429.
    await expect(submitPublicForm(validSubmission(), deps)).rejects.toBeInstanceOf(
      RateLimitError,
    );

    // Não resolveu token nem verificou captcha na chamada rejeitada extra.
    // (5 sucessos → 5 captchas / 5 resolves).
    expect(deps.captchaSpy).toHaveBeenCalledTimes(5);
    expect(deps.resolveSpy).toHaveBeenCalledTimes(5);
  });

  it("excede o limite por ChannelAccount/token (20/min) com IPs distintos → RateLimitError", async () => {
    const store = createMemoryRateLimitStore();
    const deps = makeDeps({ store });

    // 20 submissões OK com IPs distintos (não estoura o limite por IP),
    // mas mesmo token → estoura o limite por conta na 21ª.
    for (let i = 0; i < 20; i++) {
      await expect(
        submitPublicForm(validSubmission({ ip: `198.51.100.${i}` }), deps),
      ).resolves.toEqual(
        expect.objectContaining({ channelAccountId: TENANT.channelAccountId }),
      );
    }

    await expect(
      submitPublicForm(validSubmission({ ip: "198.51.100.200" }), deps),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(deps.captchaSpy).toHaveBeenCalledTimes(20);
  });

  it("erro de rate limit tem status 429", async () => {
    const err = new RateLimitError();
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limited");
  });
});

// --- CAPTCHA -----------------------------------------------------------------

describe("submitPublicForm — CAPTCHA (Req 8.3/8.4)", () => {
  it("CAPTCHA inválido → CaptchaError, sem resolver token (sem persistência)", async () => {
    const deps = makeDeps({ verifyCaptcha: async () => false });

    await expect(submitPublicForm(validSubmission(), deps)).rejects.toBeInstanceOf(
      CaptchaError,
    );
    // Nunca chegou a resolver o token → nenhum efeito/persistência.
    expect(deps.resolveSpy).not.toHaveBeenCalled();
  });

  it("token de CAPTCHA vazio → CaptchaError sem sequer invocar verifyCaptcha", async () => {
    const deps = makeDeps();
    await expect(
      submitPublicForm(validSubmission({ captchaToken: "" }), deps),
    ).rejects.toBeInstanceOf(CaptchaError);
    expect(deps.captchaSpy).not.toHaveBeenCalled();
    expect(deps.resolveSpy).not.toHaveBeenCalled();
  });
});

// --- Honeypot ----------------------------------------------------------------

describe("submitPublicForm — honeypot (Req 8.5)", () => {
  it("campo honeypot preenchido → HoneypotError (spam), sem resolver token", async () => {
    const deps = makeDeps();
    await expect(
      submitPublicForm(
        validSubmission({ payload: { ...PII, website: "http://spam.example" } }),
        deps,
      ),
    ).rejects.toBeInstanceOf(HoneypotError);
    expect(deps.resolveSpy).not.toHaveBeenCalled();
  });
});

// --- Token de formulário -----------------------------------------------------

describe("submitPublicForm — token de formulário (Req 8.6/8.7)", () => {
  it("token ausente → InvalidFormTokenError sem revelar tenant", async () => {
    const deps = makeDeps();
    const err = await submitPublicForm(
      validSubmission({ formToken: null }),
      deps,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidFormTokenError);
    // Mensagem genérica — não vaza companyId/channelAccountId.
    expect(err.message).not.toContain(TENANT.companyId);
    expect(err.message).not.toContain(TENANT.channelAccountId);
  });

  it("token inválido/expirado (resolve → null) → InvalidFormTokenError", async () => {
    const deps = makeDeps({ resolveFormToken: async () => null });
    await expect(
      submitPublicForm(validSubmission({ formToken: "tok_expired" }), deps),
    ).rejects.toBeInstanceOf(InvalidFormTokenError);
  });
});

// --- Validação Zod + ausência de PII em log ----------------------------------

describe("submitPublicForm — validação Zod e ausência de PII em log (Req 8.8)", () => {
  let spies: Array<ReturnType<typeof vi.spyOn>>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    const sink = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    spies = [
      vi.spyOn(console, "log").mockImplementation(sink),
      vi.spyOn(console, "info").mockImplementation(sink),
      vi.spyOn(console, "warn").mockImplementation(sink),
      vi.spyOn(console, "error").mockImplementation(sink),
      vi.spyOn(console, "debug").mockImplementation(sink),
    ];
  });

  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
  });

  it("payload inválido → PublicFormValidationError com campos, sem valores/PII", async () => {
    const deps = makeDeps();
    const badPii = {
      name: "", // vazio → inválido
      email: "nao-e-email", // inválido
      subject: "", // vazio
      message: "", // vazio
    };
    const err = await submitPublicForm(
      validSubmission({ payload: { ...badPii } }),
      deps,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PublicFormValidationError);
    const fields = (err as PublicFormValidationError).fields.map((f) => f.field);
    expect(fields).toContain("email");
    // Reporta nomes de campo/motivo, não os valores enviados.
    const serialized = JSON.stringify((err as PublicFormValidationError).fields);
    expect(serialized).not.toContain("nao-e-email");

    // Nada foi resolvido (sem persistência).
    expect(deps.resolveSpy).not.toHaveBeenCalled();

    // Nenhum valor de PII apareceu em qualquer log capturado.
    const allLogs = captured.join("\n");
    expect(allLogs).not.toContain(badPii.email);
  });

  it("payload válido não vaza PII em log durante o fluxo feliz", async () => {
    const deps = makeDeps();
    await submitPublicForm(validSubmission(), deps);
    const allLogs = captured.join("\n");
    for (const value of Object.values(PII)) {
      expect(allLogs).not.toContain(value);
    }
  });

  it("ignora campos de transporte extras no corpo (honeypot vazio, captchaToken) e valida só os de negócio", async () => {
    const deps = makeDeps();
    const msg = await submitPublicForm(
      validSubmission({
        payload: { ...PII, captchaToken: "captcha-abc", website: "" },
      }),
      deps,
    );
    expect(msg.body).toBe(PII.message);
  });

  it("valores de negócio fora dos limites são rejeitados (Zod)", async () => {
    const deps = makeDeps();
    await expect(
      submitPublicForm(
        validSubmission({ payload: { ...PII, message: "x".repeat(5001) } }),
        deps,
      ),
    ).rejects.toBeInstanceOf(PublicFormValidationError);
  });
});

// --- Contrato ChannelAdapter -------------------------------------------------

describe("PublicFormAdapter — consistência com o modelo de canais", () => {
  it("declara type/provider/capabilities de canal inbound-only", () => {
    const deps = makeDeps();
    const adapter = createPublicFormAdapter(deps);
    expect(adapter.type).toBe(ChannelType.PUBLIC_FORM);
    expect(adapter.provider).toBe(ChannelProvider.INTERNAL);
    expect(adapter.capabilities()).toEqual({
      supportsMedia: false,
      supportsTemplates: false,
      hasSessionWindow: false,
    });
  });

  it("send() retorna SendResult não aceito (inbound-only)", async () => {
    const deps = makeDeps();
    const adapter = createPublicFormAdapter(deps);
    const result = await adapter.send(
      {
        id: "acct-123",
        companyId: TENANT.companyId,
        type: ChannelType.PUBLIC_FORM,
        provider: ChannelProvider.INTERNAL,
        secretRef: "ref",
      },
      { conversationId: "c1", type: MessageType.TEXT, body: "oi" },
    );
    expect(result.accepted).toBe(false);
  });

  it("parseInbound deriva tenant do header x-form-token (não do corpo)", async () => {
    const deps = makeDeps();
    const adapter = createPublicFormAdapter(deps);
    const messages = await adapter.parseInbound({
      method: "POST",
      headers: {
        "x-form-token": VALID_TOKEN,
        "x-captcha-token": "captcha-abc",
        "x-forwarded-for": "203.0.113.55",
      },
      query: {},
      rawBody: JSON.stringify({ ...PII, companyId: "ATACANTE" }),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].companyId).toBe(TENANT.companyId);
  });
});
