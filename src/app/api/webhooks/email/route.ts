/**
 * Webhook de e-mail — rota de COMPATIBILIDADE.
 *
 * Esta rota (`/api/webhooks/email`) foi APOSENTADA como implementação própria.
 * A lógica oficial vive em `/api/webhooks/email/v2`, que usa o padrão
 * provider/adapter (`EmailAdapter` + `IngestionRouter`) e roteia por EMPRESA
 * via `ChannelAccount` (endereço de destino → tenant), sem misturar chamados.
 *
 * Para não quebrar webhooks porventura ainda apontados para esta URL, ela
 * DELEGA integralmente ao handler v2 (mesma verificação de assinatura Svix,
 * mesmo roteamento). O comportamento antigo (criar ticket pelo REMETENTE,
 * ignorando a caixa de destino) foi removido.
 */
import { NextResponse, type NextRequest } from "next/server";

import { toRawRequest } from "@/lib/channels/http";
import { buildEmailAdapter } from "@/lib/channels/wiring";
import { createIngestionRouter } from "@/lib/ingestion/router";
import type { InboundMessage } from "@/lib/domain";
import { handleEmailPost, type EmailHandlerDeps } from "./v2/handler";

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
