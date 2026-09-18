/**
 * Handlers PUROS do webhook do WhatsApp (tarefa 21.1).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Recebimento (webhook)") e requisitos 5.2, 5.3, 6.3, 6.5, 6.6.
 *
 * Estes handlers são independentes do runtime do Next: recebem um
 * {@link RawRequest} (agnóstico de canal) e as dependências injetadas
 * (`adapter`, `route`). O `route.ts` adapta `NextRequest → RawRequest` e chama
 * estas funções — o que as torna testáveis SEM o runtime completo do Next e SEM
 * tocar em banco/rede.
 *
 * GARANTIA "assinatura ANTES de parse": o POST chama `adapter.verifyInbound`
 * PRIMEIRO; somente em `true` chama `adapter.parseInbound` e `route`. Em
 * assinatura inválida/ausente, retorna 401 e NÃO invoca `parseInbound`/`route`
 * (nenhum `Message`/`Ticket`).
 */

import type { ChannelAdapter, RawRequest } from "@/lib/channels/adapter";
import type { InboundMessage } from "@/lib/domain";
import { IngestionError } from "@/lib/ingestion/router";

/** Resultado agnóstico de HTTP produzido pelos handlers puros. */
export interface HandlerResult {
  status: number;
  /** Corpo textual (handshake) ou JSON serializável. */
  body: string | Record<string, unknown>;
  /** `text/plain` para o handshake; JSON caso contrário. */
  contentType: "text/plain" | "application/json";
}

/** Roteador injetável: consome uma `InboundMessage` normalizada. */
export type RouteFn = (msg: InboundMessage) => Promise<unknown>;

/** Dependências injetadas dos handlers puros. */
export interface WhatsAppHandlerDeps {
  adapter: ChannelAdapter;
  route: RouteFn;
}

/**
 * GET — handshake de verificação (Req 6.3/6.4).
 *
 * Chama `adapter.verifyInbound(req)`; se `true`, responde 200 com o valor bruto
 * de `hub.challenge` em `text/plain`. Se `false`, responde 403 sem `challenge`.
 */
export async function handleWhatsAppGet(
  req: RawRequest,
  deps: WhatsAppHandlerDeps,
): Promise<HandlerResult> {
  const verified = await deps.adapter.verifyInbound(req);
  if (!verified) {
    return {
      status: 403,
      body: { error: "verification_failed" },
      contentType: "application/json",
    };
  }
  const challenge = req.query["hub.challenge"] ?? "";
  return { status: 200, body: challenge, contentType: "text/plain" };
}

/**
 * POST — evento de mensagem (Req 5.2, 5.3, 6.5, 6.6).
 *
 * Ordem inviolável:
 *   1. `verifyInbound` (HMAC do corpo bruto). Inválido ⇒ 401 e NADA mais
 *      (não chama `parseInbound`/`route`).
 *   2. `parseInbound` → `InboundMessage[]`.
 *   3. Para cada mensagem, `route(msg)`; `IngestionError` é capturado por
 *      mensagem (descarta aquela e continua), sem falhar o webhook.
 *   4. Responde 200 rápido (Meta exige ack rápido; trabalho pesado é
 *      transacional/outbox).
 *
 * NUNCA loga segredos/PII: apenas contagens e motivos técnicos.
 */
export async function handleWhatsAppPost(
  req: RawRequest,
  deps: WhatsAppHandlerDeps,
): Promise<HandlerResult> {
  // (1) Verificação de assinatura ANTES de qualquer processamento.
  const verified = await deps.adapter.verifyInbound(req);
  if (!verified) {
    return {
      status: 401,
      body: { error: "signature_invalid" },
      contentType: "application/json",
    };
  }

  // (2) Normalização (só após verificação).
  const messages = await deps.adapter.parseInbound(req);

  // (3) Roteamento por mensagem — erros de ingestão são isolados.
  let routed = 0;
  let discarded = 0;
  for (const msg of messages) {
    try {
      await deps.route(msg);
      routed += 1;
    } catch (err) {
      if (err instanceof IngestionError) {
        // Descarta apenas esta mensagem (conta desconhecida, tenant mismatch,
        // canal desconhecido). Sem PII: só o motivo técnico.
        discarded += 1;
        continue;
      }
      // Erro inesperado: não trava o ack da Meta; contabiliza como descartada.
      discarded += 1;
    }
  }

  // (4) Ack rápido 200.
  return {
    status: 200,
    body: { received: messages.length, routed, discarded },
    contentType: "application/json",
  };
}
