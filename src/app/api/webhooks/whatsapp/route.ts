/**
 * Route handler do webhook do WhatsApp (Meta Cloud API) — tarefa 21.1.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Recebimento (webhook)") e requisitos 5.2, 5.3, 6.3, 6.5, 6.6.
 *
 * Este arquivo é uma casca FINA: adapta `NextRequest → RawRequest`, monta as
 * dependências pelo wiring (adaptador selecionado por env + `IngestionRouter`
 * DB-backed) e delega aos handlers PUROS (`handler.ts`), que contêm toda a
 * lógica testável.
 *
 *  - GET: handshake de verificação. `verifyInbound` valida `hub.verify_token`
 *    contra o segredo do `secretRef` (query `__secretRef` ou conta padrão do
 *    env). Sucesso ⇒ 200 com `hub.challenge` em `text/plain`; falha ⇒ 403.
 *  - POST: lê o corpo BRUTO (`req.text()`) e verifica `x-hub-signature-256`
 *    ANTES de parsear. Assinatura inválida ⇒ 401 e NADA é processado. Válida ⇒
 *    normaliza e roteia cada mensagem; responde 200 rápido.
 *
 * Nunca loga segredos/PII.
 */

import { NextResponse, type NextRequest } from "next/server";

import { toRawRequest } from "@/lib/channels/http";
import {
  buildWhatsAppAdapter,
  defaultWhatsAppSecretRef,
} from "@/lib/channels/wiring";
import { createIngestionRouter } from "@/lib/ingestion/router";
import type { InboundMessage } from "@/lib/domain";
import {
  handleWhatsAppGet,
  handleWhatsAppPost,
  type HandlerResult,
  type WhatsAppHandlerDeps,
} from "./handler";

/** Webhooks precisam do runtime Node (crypto/HMAC) e sem cache. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Monta as dependências reais (adaptador por env + router DB-backed). */
function buildDeps(): WhatsAppHandlerDeps {
  const adapter = buildWhatsAppAdapter();
  const router = createIngestionRouter();
  return {
    adapter,
    route: (msg: InboundMessage) => router.route(msg),
  };
}

/** Traduz o {@link HandlerResult} puro em `Response` do Next. */
function toResponse(result: HandlerResult): Response {
  if (result.contentType === "text/plain") {
    return new NextResponse(String(result.body), {
      status: result.status,
      headers: { "content-type": "text/plain" },
    });
  }
  return NextResponse.json(result.body as Record<string, unknown>, {
    status: result.status,
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const raw = await toRawRequest(req);
  // Se nenhum `__secretRef` foi informado na query, usa a conta padrão do env
  // para a verificação do handshake (single-account).
  if (!raw.query["__secretRef"]) {
    raw.query["__secretRef"] = defaultWhatsAppSecretRef();
  }
  const result = await handleWhatsAppGet(raw, buildDeps());
  return toResponse(result);
}

export async function POST(req: NextRequest): Promise<Response> {
  const raw = await toRawRequest(req);
  if (!raw.query["__secretRef"]) {
    raw.query["__secretRef"] = defaultWhatsAppSecretRef();
  }
  const result = await handleWhatsAppPost(raw, buildDeps());
  return toResponse(result);
}
