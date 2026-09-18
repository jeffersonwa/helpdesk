/**
 * Testes do handler de formulário público seguro — tarefa 21.2.
 *
 * Estilo unit: `handlePublicFormPost` com deps injetadas (rate limiter em
 * memória, `verifyCaptcha`/`resolveFormToken` stubados, `route` espião).
 * Cobre o mapeamento de erros do Req 8: 429/400/422/200-honeypot/404 e o
 * caminho de sucesso (200 + roteamento). Nenhuma PII é registrada.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createMemoryRateLimitStore,
  createRateLimiter,
} from "@/lib/rate-limit";
import type {
  PublicFormSubmission,
  ResolvedFormToken,
} from "@/lib/channels/public-form/adapter";
import type { InboundMessage } from "@/lib/domain";
import { IngestionError } from "@/lib/ingestion/router";

import {
  handlePublicFormPost,
  type PublicFormHandlerDeps,
} from "../handler";

const VALID_TOKEN = "form-token-valid";
const PII = {
  name: "Fulano de Tal",
  email: "fulano@example.com",
  subject: "Preciso de ajuda",
  message: "Corpo da mensagem",
};

function makeDeps(
  opts: {
    now?: () => number;
    verifyCaptcha?: (t: string) => Promise<boolean>;
    resolveFormToken?: (t: string) => Promise<ResolvedFormToken | null>;
    route?: (m: InboundMessage) => Promise<unknown>;
  } = {},
): PublicFormHandlerDeps & { routeSpy: ReturnType<typeof vi.fn> } {
  const now = opts.now ?? (() => 1_000_000);
  const rateLimiter = createRateLimiter({
    store: createMemoryRateLimitStore(),
    now,
  });
  const routeSpy = vi.fn(opts.route ?? (async () => undefined));
  return {
    rateLimiter,
    verifyCaptcha: opts.verifyCaptcha ?? (async () => true),
    resolveFormToken:
      opts.resolveFormToken ??
      (async (t) =>
        t === VALID_TOKEN
          ? { channelAccountId: "acc-form", companyId: "c1" }
          : null),
    now,
    generateId: () => "fixed",
    route: routeSpy as unknown as PublicFormHandlerDeps["route"],
    routeSpy,
  };
}

function submission(over: Partial<PublicFormSubmission> = {}): PublicFormSubmission {
  return {
    formToken: VALID_TOKEN,
    ip: "203.0.113.10",
    captchaToken: "captcha-ok",
    payload: { ...PII },
    ...over,
  };
}

describe("handlePublicFormPost", () => {
  it("sucesso → 200 e roteia a InboundMessage (tenant do token)", async () => {
    const deps = makeDeps();
    const res = await handlePublicFormPost(submission(), deps);
    expect(res.status).toBe(200);
    expect(deps.routeSpy).toHaveBeenCalledTimes(1);
    const routedMsg = deps.routeSpy.mock.calls[0]![0] as InboundMessage;
    expect(routedMsg.companyId).toBe("c1");
    expect(routedMsg.channelAccountId).toBe("acc-form");
  });

  it("captcha inválido → 400 e não roteia", async () => {
    const deps = makeDeps({ verifyCaptcha: async () => false });
    const res = await handlePublicFormPost(submission(), deps);
    expect(res.status).toBe(400);
    expect(deps.routeSpy).not.toHaveBeenCalled();
  });

  it("honeypot preenchido → 200 silencioso e não roteia", async () => {
    const deps = makeDeps();
    const res = await handlePublicFormPost(
      submission({ payload: { ...PII, website: "http://spam" } }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(deps.routeSpy).not.toHaveBeenCalled();
  });

  it("payload inválido → 422 com campos (sem PII)", async () => {
    const deps = makeDeps();
    const res = await handlePublicFormPost(
      submission({ payload: { name: "", email: "x", subject: "", message: "" } }),
      deps,
    );
    expect(res.status).toBe(422);
    const body = res.body as { error: string; fields: unknown[] };
    expect(body.error).toBe("invalid_payload");
    expect(Array.isArray(body.fields)).toBe(true);
    // Nenhum valor de PII aparece no corpo de erro.
    expect(JSON.stringify(res.body)).not.toContain("fulano@example.com");
  });

  it("token inválido → 404 genérico (não revela tenant) e não roteia", async () => {
    const deps = makeDeps();
    const res = await handlePublicFormPost(
      submission({ formToken: "token-errado" }),
      deps,
    );
    expect(res.status).toBe(404);
    expect(deps.routeSpy).not.toHaveBeenCalled();
  });

  it("rate limit por IP excedido → 429", async () => {
    const deps = makeDeps();
    // 5 permitidas por IP/min; a 6ª estoura.
    for (let i = 0; i < 5; i++) {
      const r = await handlePublicFormPost(submission(), deps);
      expect(r.status).toBe(200);
    }
    const sixth = await handlePublicFormPost(submission(), deps);
    expect(sixth.status).toBe(429);
  });

  it("IngestionError na ingestão → 404 genérico", async () => {
    const deps = makeDeps({
      route: async () => {
        throw new IngestionError("ACCOUNT_NOT_RESOLVED", "sem conta");
      },
    });
    const res = await handlePublicFormPost(submission(), deps);
    expect(res.status).toBe(404);
  });
});
