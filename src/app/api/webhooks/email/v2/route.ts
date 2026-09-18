/**
 * Route handler OFICIAL (v2) do webhook de e-mail — tarefa 21.1.
 *
 * Fonte: `.kiro/specs/helpdesk-omnichannel/design.md` e requisitos 7.1, 7.2.
 *
 * ------------------------------------------------------------------------
 * SUPERSEDES o handler legado em `src/app/api/webhooks/email/route.ts`.
 * ------------------------------------------------------------------------
 * O legado cria tickets diretamente (fora do padrão provider/adapter) e é
 * mantido intacto para não quebrar integrações existentes; pode ser APOSENTADO
 * depois que os provedores forem apontados para `/api/webhooks/email/v2`.
 *
 * Esta rota usa o `EmailAdapter` (verificação de assinatura do provedor via
 * env) e o `IngestionRouter` DB-backed. Casca fina: adapta `NextRequest →
 * RawRequest` e delega ao handler puro.
 */

import { NextResponse, type NextRequest } from "next/server";

import { toRawRequest } from "@/lib/channels/http";
import { buildEmailAdapter } from "@/lib/channels/wiring";
import { createIngestionRouter } from "@/lib/ingestion/router";
import type { InboundMessage } from "@/lib/domain";
import { handleEmailPost, type EmailHandlerDeps } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildDeps(): EmailHandlerDeps {
  const adapter = buildEmailAdapter();
  const router = createIngestionRouter();
  return {
    adapter,
    route: (msg: InboundMessage) => router.route(msg),
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const raw = await toRawRequest(req);
  const result = await handleEmailPost(raw, buildDeps());
  return NextResponse.json(result.body as Record<string, unknown>, {
    status: result.status,
  });
}
