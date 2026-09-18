/**
 * Handler PURO do webhook de e-mail OFICIAL (v2) — tarefa 21.1.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Fluxo de Ingestão por E-mail") e requisitos 7.1, 7.2.
 *
 * SUPERSEDES: `src/app/api/webhooks/email/route.ts` (legado). O legado
 * permanece intacto e pode ser aposentado depois. Esta rota v2 usa o
 * `EmailAdapter` (padrão provider/adapter), verificando a assinatura do
 * provedor ANTES de parsear e delegando ao `IngestionRouter`.
 *
 * Testável sem o runtime do Next: recebe {@link RawRequest} + deps injetadas.
 */

import type { ChannelAdapter, RawRequest } from "@/lib/channels/adapter";
import type { InboundMessage } from "@/lib/domain";
import { IngestionError } from "@/lib/ingestion/router";
import type { HandlerResult, RouteFn } from "@/app/api/webhooks/whatsapp/handler";

/** Dependências injetadas do handler de e-mail v2. */
export interface EmailHandlerDeps {
  adapter: ChannelAdapter;
  route: RouteFn;
}

/**
 * POST — inbound webhook de e-mail (Req 7.1/7.2).
 *
 * 1. `verifyInbound` (assinatura do provedor). Inválido/ausente ⇒ 401 e NADA
 *    processado (nenhuma `InboundMessage`/`Message`).
 * 2. `parseInbound` → `InboundMessage[]` (normalização em ≤5s).
 * 3. `route(msg)` por mensagem; `IngestionError` isola a mensagem e continua.
 * 4. Responde 200.
 */
export async function handleEmailPost(
  req: RawRequest,
  deps: EmailHandlerDeps,
): Promise<HandlerResult> {
  const verified = await deps.adapter.verifyInbound(req);
  if (!verified) {
    return {
      status: 401,
      body: { error: "signature_invalid" },
      contentType: "application/json",
    };
  }

  const messages: InboundMessage[] = await deps.adapter.parseInbound(req);

  let routed = 0;
  let discarded = 0;
  for (const msg of messages) {
    try {
      await deps.route(msg);
      routed += 1;
    } catch (err) {
      if (err instanceof IngestionError) {
        discarded += 1;
        continue;
      }
      discarded += 1;
    }
  }

  return {
    status: 200,
    body: { received: messages.length, routed, discarded },
    contentType: "application/json",
  };
}
