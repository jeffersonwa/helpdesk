/**
 * Handler PURO do formulário público seguro — tarefa 21.1.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Segurança do Formulário Público") e requisito 8.
 *
 * Delega a `submitPublicForm` (adapter) com deps injetadas e roteia a
 * `InboundMessage` resultante. Mapeia os erros TIPADOS do adapter em status
 * HTTP (Req 8):
 *   - RateLimitError            → 429
 *   - CaptchaError              → 400
 *   - PublicFormValidationError → 422 (com campos, sem PII)
 *   - HoneypotError             → 200 (rejeição silenciosa como spam)
 *   - InvalidFormTokenError     → 404 (genérico, não revela tenant)
 *
 * NUNCA loga PII (nome/e-mail/assunto/mensagem).
 */

import {
  submitPublicForm,
  PublicFormError,
  PublicFormValidationError,
  type PublicFormDeps,
  type PublicFormSubmission,
} from "@/lib/channels/public-form/adapter";
import type { InboundMessage } from "@/lib/domain";
import { IngestionError } from "@/lib/ingestion/router";
import type { HandlerResult, RouteFn } from "@/app/api/webhooks/whatsapp/handler";

/** Dependências injetadas do handler de formulário público. */
export interface PublicFormHandlerDeps extends PublicFormDeps {
  route: RouteFn;
}

/**
 * Processa uma submissão de formulário público. Em sucesso, roteia a
 * `InboundMessage` (o tenant vem do TOKEN) e responde 200. Em erro, traduz o
 * subtipo de {@link PublicFormError} no status apropriado.
 */
export async function handlePublicFormPost(
  submission: PublicFormSubmission,
  deps: PublicFormHandlerDeps,
): Promise<HandlerResult> {
  let message: InboundMessage;
  try {
    message = await submitPublicForm(submission, deps);
  } catch (err) {
    if (err instanceof PublicFormValidationError) {
      return {
        status: err.status, // 422
        body: { error: err.code, fields: err.fields },
        contentType: "application/json",
      };
    }
    if (err instanceof PublicFormError) {
      // Honeypot usa status 200 (silencioso); os demais, seus status próprios.
      return {
        status: err.status,
        body:
          err.status === 200
            ? { received: 1 }
            : { error: err.code },
        contentType: "application/json",
      };
    }
    throw err;
  }

  // Sucesso do intake → roteia. IngestionError não vaza detalhes ao cliente.
  try {
    await deps.route(message);
  } catch (err) {
    if (err instanceof IngestionError) {
      // Descartado na ingestão (ex.: conta não resolvida) — resposta genérica.
      return {
        status: 404,
        body: { error: "invalid_form_token" },
        contentType: "application/json",
      };
    }
    throw err;
  }

  return {
    status: 200,
    body: { received: 1 },
    contentType: "application/json",
  };
}
