/**
 * Route handler do formulário público seguro — tarefa 21.1.
 *
 * Fonte: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Segurança do Formulário Público") e requisito 8.
 *
 * POST: lê o JSON do corpo, deriva:
 *   - form token do header `x-form-token` ou query `token` (NUNCA do corpo);
 *   - captcha do header `x-captcha-token` ou do corpo (`captchaToken`);
 *   - IP de `x-forwarded-for` (primeiro salto) / `x-real-ip`.
 * Monta as deps pelo wiring (rate limiter de processo, verifyCaptcha por env,
 * resolveFormToken DB-backed) e delega ao handler puro, que aplica as
 * verificações do Req 8 na ordem e mapeia os erros a status HTTP.
 *
 * Nunca loga PII.
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  getPublicFormRateLimiter,
  createEnvCaptchaVerifier,
  createDbFormTokenResolver,
} from "@/lib/channels/wiring";
import { createIngestionRouter } from "@/lib/ingestion/router";
import type { InboundMessage } from "@/lib/domain";
import type { PublicFormSubmission } from "@/lib/channels/public-form/adapter";
import {
  handlePublicFormPost,
  type PublicFormHandlerDeps,
} from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildDeps(): PublicFormHandlerDeps {
  const router = createIngestionRouter();
  return {
    rateLimiter: getPublicFormRateLimiter(),
    verifyCaptcha: createEnvCaptchaVerifier(),
    resolveFormToken: createDbFormTokenResolver(),
    route: (msg: InboundMessage) => router.route(msg),
  };
}

/** Extrai o IP do submissor de forma segura (primeiro salto do XFF). */
function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: NextRequest): Promise<Response> {
  // Corpo JSON (payload de negócio + honeypot + captchaToken opcional).
  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json(
      { error: "invalid_payload" },
      { status: 422 },
    );
  }

  // Token do formulário: header OU query — NUNCA do corpo (Req 8.6).
  const formToken =
    req.headers.get("x-form-token") ??
    req.nextUrl.searchParams.get("token") ??
    undefined;

  // Captcha: header preferido; fallback ao corpo.
  const captchaToken =
    req.headers.get("x-captcha-token") ??
    (typeof body["captchaToken"] === "string"
      ? (body["captchaToken"] as string)
      : "");

  const submission: PublicFormSubmission = {
    formToken,
    ip: clientIp(req),
    captchaToken,
    payload: body,
  };

  const result = await handlePublicFormPost(submission, buildDeps());
  return NextResponse.json(result.body as Record<string, unknown>, {
    status: result.status,
  });
}
