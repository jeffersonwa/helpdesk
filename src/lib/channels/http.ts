/**
 * Adaptação `NextRequest → RawRequest` para os route handlers de canais.
 *
 * Fonte: `.kiro/specs/helpdesk-omnichannel/design.md` (RawRequest agnóstico de
 * canal). Isola a única dependência do runtime do Next fora dos handlers puros,
 * mantendo-os testáveis.
 *
 * REGRA CRÍTICA: o corpo é lido como TEXTO BRUTO (`await req.text()`) e NÃO é
 * parseado aqui — a verificação HMAC precisa do payload exato recebido. Os
 * handlers chamam `verifyInbound` antes de qualquer `JSON.parse`.
 */

import type { NextRequest } from "next/server";

import type { RawRequest } from "@/lib/channels/adapter";

/** Cabeçalhos em MINÚSCULAS (verificação HMAC busca `x-hub-signature-256`). */
export function lowercaseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Query params como objeto simples (`hub.mode`, `hub.challenge`, `token`, ...). */
export function queryToRecord(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Constrói um {@link RawRequest} a partir de um `NextRequest`, lendo o corpo
 * bruto quando o método pode ter corpo (POST/PUT/PATCH). Para GET, `rawBody`
 * é a string vazia.
 */
export async function toRawRequest(req: NextRequest): Promise<RawRequest> {
  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const rawBody = hasBody ? await req.text() : "";
  return {
    method,
    headers: lowercaseHeaders(req.headers),
    query: queryToRecord(req.nextUrl),
    rawBody,
  };
}
