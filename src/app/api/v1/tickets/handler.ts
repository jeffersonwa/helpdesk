/**
 * Handler PURO da ingestão de tickets via API (v1) — tarefa 21.1.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md` e
 * requisito 9.
 *
 * ------------------------------------------------------------------------
 * PATH v1 (não quebra a rota legada `src/app/api/tickets/route.ts`).
 * ------------------------------------------------------------------------
 * A rota legada de tickets (autenticada por sessão de usuário) permanece
 * intacta. Esta rota v1 é a ingestão por API de integração/serviço, autenticada
 * por Bearer token, delegando ao `ApiAdapter` (que reusa o `TicketService`:
 * numeração/prioridade/SLA/autorização no backend).
 *
 * Mapeia os erros tipados do adapter em status HTTP (Req 9):
 *   - ApiUnauthenticatedError → 401
 *   - ApiForbiddenError       → 403
 *   - ApiValidationError      → 422 (campo + motivo)
 *
 * O tenant vem SEMPRE do `ApiAuthContext` (servidor), nunca do payload (Req 9.1).
 */

import {
  createTicketViaApi,
  updateTicketViaApi,
  ApiUnauthenticatedError,
  ApiForbiddenError,
  ApiValidationError,
  type ApiAuthContext,
  type ApiCreateTicketInput,
  type ApiUpdateTicketInput,
} from "@/lib/channels/api/adapter";
import type { HandlerResult } from "@/app/api/webhooks/whatsapp/handler";

/** Autenticador injetável: resolve o header Authorization → contexto. */
export type Authenticate = (
  authorizationHeader: string | null | undefined,
) => Promise<ApiAuthContext>;

/** Dependências injetadas do handler v1. */
export interface ApiTicketsHandlerDeps {
  authenticate: Authenticate;
}

/** Traduz erros tipados do adapter em {@link HandlerResult}. */
function toErrorResult(err: unknown): HandlerResult {
  if (err instanceof ApiValidationError) {
    return {
      status: 422,
      body: { error: err.code, fields: err.fieldErrors },
      contentType: "application/json",
    };
  }
  if (err instanceof ApiForbiddenError) {
    return {
      status: 403,
      body: { error: err.code },
      contentType: "application/json",
    };
  }
  if (err instanceof ApiUnauthenticatedError) {
    return {
      status: 401,
      body: { error: err.code },
      contentType: "application/json",
    };
  }
  throw err;
}

/**
 * POST — cria um ticket via API autenticada (Req 9.1–9.6). Autentica, delega ao
 * `ApiAdapter.createTicketViaApi` (tenant do contexto) e responde 201 com o id.
 */
export async function handleApiCreateTicket(
  authorizationHeader: string | null | undefined,
  input: ApiCreateTicketInput,
  deps: ApiTicketsHandlerDeps,
): Promise<HandlerResult> {
  const authContext = await deps.authenticate(authorizationHeader);
  try {
    const result = await createTicketViaApi(authContext, input);
    return {
      status: 201,
      body: {
        ticketId: result.ticketId,
        number: result.number,
        status: result.status,
      },
      contentType: "application/json",
    };
  } catch (err) {
    return toErrorResult(err);
  }
}

/**
 * PATCH/PUT — atualiza o status de um ticket via API autenticada (Req 9).
 * Delega ao `ApiAdapter.updateTicketViaApi`.
 */
export async function handleApiUpdateTicket(
  authorizationHeader: string | null | undefined,
  input: ApiUpdateTicketInput,
  deps: ApiTicketsHandlerDeps,
): Promise<HandlerResult> {
  const authContext = await deps.authenticate(authorizationHeader);
  try {
    const result = await updateTicketViaApi(authContext, input);
    return {
      status: 200,
      body: { ticketId: result.ticketId, status: result.status },
      contentType: "application/json",
    };
  } catch (err) {
    return toErrorResult(err);
  }
}
