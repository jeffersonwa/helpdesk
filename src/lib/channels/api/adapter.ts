/**
 * `ApiAdapter` — ingestão via API autenticada (Req. 9).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md` e
 * requirements 9.1–9.6.
 *
 * ------------------------------------------------------------------------
 * PAPEL (adaptador FINO): autenticação + autorização + validação + delegação.
 * ------------------------------------------------------------------------
 * O `ApiAdapter` NÃO reimplementa a lógica de tickets. Ele:
 *   1. Garante que a requisição está AUTENTICADA (conta de integração/serviço);
 *      caso contrário → {@link ApiUnauthenticatedError} (401). (Req. 9.2)
 *   2. Deriva o tenant EXCLUSIVAMENTE da conta autenticada, IGNORANDO qualquer
 *      `companyId`/tenant informado no payload. (Req. 9.1)
 *   3. Valida o payload com Zod ANTES de persistir (título 1–200, descrição
 *      1–5.000, ≤50 anexos); falha → {@link ApiValidationError} (422) com
 *      campo+motivo e NADA persistido. (Req. 9.4, 9.5)
 *   4. Delega a criação/atualização ao `TicketService` existente
 *      (`createTicket`/`changeTicketStatus`), que aplica `Authorization.assert`
 *      no backend — negação vira {@link ApiForbiddenError} (403). Assim toda a
 *      lógica de numeração/prioridade/SLA/autorização é REUTILIZADA. (Req. 9.3)
 *   5. Não introduz atraso artificial — retorna assim que a delegação conclui
 *      (Req. 9.6, "≤2s sob carga nominal").
 *
 * PRINCÍPIO INVIOLÁVEL: `companyId` sempre derivado no servidor. O
 * `authContext.companyId` é a ÚNICA fonte de tenant; o payload validado (schema
 * Zod) nem sequer conhece `companyId`.
 *
 * _Requisitos: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
 */

import { z } from "zod";

import { Impact, TicketStatus, Urgency } from "@/lib/domain/enums";
import { ChannelType } from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import { AuthorizationError } from "@/lib/rbac/authorization";
import {
  changeTicketStatus,
  createTicket,
  isValidTicketStatus,
  type ChangeStatusResult,
  type CreateTicketResult,
  type TicketPrisma,
  type TicketStatusPrisma,
} from "@/lib/tickets/service";

/** Máximo de anexos por requisição (Req. 9.4). */
export const API_MAX_ATTACHMENTS = 50 as const;

// ---------------------------------------------------------------------------
// Erros tipados (traduzidos em 401/403/422 na borda)
// ---------------------------------------------------------------------------

/** Requisição não autenticada → 401 (Req. 9.2). */
export class ApiUnauthenticatedError extends Error {
  readonly code = "API_UNAUTHENTICATED" as const;
  readonly status = 401 as const;
  constructor(message = "Autenticação obrigatória") {
    super(message);
    this.name = "ApiUnauthenticatedError";
    Object.setPrototypeOf(this, ApiUnauthenticatedError.prototype);
  }
}

/** Autenticada, porém não autorizada para a ação → 403 (Req. 9.3). */
export class ApiForbiddenError extends Error {
  readonly code = "API_FORBIDDEN" as const;
  readonly status = 403 as const;
  constructor(message = "Não autorizado") {
    super(message);
    this.name = "ApiForbiddenError";
    Object.setPrototypeOf(this, ApiForbiddenError.prototype);
  }
}

/** Detalhe de campo inválido da validação (campo + motivo). */
export interface ApiFieldError {
  field: string;
  reason: string;
}

/** Falha de validação Zod → 422 com campo+motivo, nada persistido (Req. 9.5). */
export class ApiValidationError extends Error {
  readonly code = "API_VALIDATION" as const;
  readonly status = 422 as const;
  readonly fieldErrors: ApiFieldError[];
  constructor(error: z.ZodError) {
    super("Payload de API inválido");
    this.name = "ApiValidationError";
    this.fieldErrors = error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "(raiz)",
      reason: issue.message,
    }));
    (this as { cause?: unknown }).cause = error;
    Object.setPrototypeOf(this, ApiValidationError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Contexto de autenticação e dependências
// ---------------------------------------------------------------------------

/**
 * Contexto de uma requisição autenticada por conta de integração/serviço.
 *
 * `authenticated: false` (ou ausência de contexto) ⇒ 401. Quando autenticado,
 * `companyId` é o tenant DERIVADO no servidor (nunca do payload) e `user` é o
 * `SessionUser` usado pelo `Authorization.assert` do `TicketService`.
 */
export type ApiAuthContext =
  | { authenticated: false }
  | { authenticated: true; companyId: string; user: SessionUser };

/**
 * Dependências injetáveis do adaptador — permitem testes puros.
 * Por padrão o adaptador usa o `TicketService` real; os testes podem injetar
 * um `createTicket`/`changeTicketStatus` mockado ou apenas um `prisma` stub.
 */
export interface ApiAdapterDeps {
  /** Delegado de criação (padrão: `createTicket` do TicketService). */
  createTicket?: typeof createTicket;
  /** Delegado de atualização de status (padrão: `changeTicketStatus`). */
  changeTicketStatus?: typeof changeTicketStatus;
  /** Prisma repassado ao TicketService (stub nos testes). */
  prisma?: TicketPrisma & TicketStatusPrisma;
}

// ---------------------------------------------------------------------------
// Schemas Zod (Req. 9.4)
// ---------------------------------------------------------------------------

/** Sub-schema de anexo — apenas metadados; conteúdo tratado noutra camada. */
const attachmentSchema = z.object({
  id: z.string().trim().min(1).optional(),
  filename: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
});

/**
 * Schema de criação via API. NÃO inclui `companyId`/tenant: um tenant no corpo
 * é literalmente ignorado (o schema o desconhece) — Req. 9.1.
 * Limites: título 1–200, descrição 1–5.000, ≤50 anexos (Req. 9.4).
 */
export const apiCreateTicketSchema = z.object({
  title: z
    .string({ error: "título é obrigatório" })
    .trim()
    .min(1, "título é obrigatório")
    .max(200, "título deve ter no máximo 200 caracteres"),
  description: z
    .string({ error: "descrição é obrigatória" })
    .trim()
    .min(1, "descrição é obrigatória")
    .max(5000, "descrição deve ter no máximo 5.000 caracteres"),
  createdById: z
    .string({ error: "solicitante é obrigatório" })
    .trim()
    .min(1, "solicitante é obrigatório"),
  impact: z.enum(Impact).optional(),
  urgency: z.enum(Urgency).optional(),
  attachments: z
    .array(attachmentSchema)
    .max(API_MAX_ATTACHMENTS, `máximo de ${API_MAX_ATTACHMENTS} anexos por requisição`)
    .optional(),
  // Campos de classificação opcionais (repassados ao TicketService).
  unitId: z.string().trim().min(1).optional(),
  departmentId: z.string().trim().min(1).optional(),
  serviceId: z.string().trim().min(1).optional(),
  categoryId: z.string().trim().min(1).optional(),
  subcategoryId: z.string().trim().min(1).optional(),
  categoryItemId: z.string().trim().min(1).optional(),
  queueId: z.string().trim().min(1).optional(),
  teamId: z.string().trim().min(1).optional(),
  assignedToId: z.string().trim().min(1).optional(),
});

/** Schema de atualização de status via API (Req. 9). */
export const apiUpdateTicketSchema = z.object({
  ticketId: z
    .string({ error: "ticketId é obrigatório" })
    .trim()
    .min(1, "ticketId é obrigatório"),
  status: z
    .string({ error: "status é obrigatório" })
    .trim()
    .min(1, "status é obrigatório")
    .refine(isValidTicketStatus, "status inválido"),
});

export type ApiCreateTicketInput = z.input<typeof apiCreateTicketSchema>;
export type ApiUpdateTicketInput = z.input<typeof apiUpdateTicketSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Executa o corpo e traduz `AuthorizationError` (do TicketService) em
 * {@link ApiForbiddenError} (403). Outros erros sobem inalterados.
 */
async function translateAuthz<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (
      err instanceof AuthorizationError ||
      (err as { code?: string })?.code === "AUTHORIZATION_DENIED"
    ) {
      throw new ApiForbiddenError();
    }
    throw err;
  }
}

/** Garante autenticação (Req. 9.2); retorna o contexto estreitado. */
function requireAuth(
  authContext: ApiAuthContext | null | undefined,
): { companyId: string; user: SessionUser } {
  if (!authContext || authContext.authenticated !== true) {
    throw new ApiUnauthenticatedError();
  }
  return { companyId: authContext.companyId, user: authContext.user };
}

// ---------------------------------------------------------------------------
// Operações da API
// ---------------------------------------------------------------------------

/**
 * Cria um ticket via API autenticada (Req. 9.1–9.6).
 *
 * Ordem: autenticação → validação (nada persistido em falha) → delegação ao
 * `TicketService.createTicket`, que autoriza no backend e reusa
 * numeração/prioridade/SLA. O tenant vem SEMPRE de `authContext.companyId`.
 */
export async function createTicketViaApi(
  authContext: ApiAuthContext | null | undefined,
  input: ApiCreateTicketInput,
  deps: ApiAdapterDeps = {},
): Promise<CreateTicketResult> {
  // (1) Autenticação (Req. 9.2).
  const { companyId, user } = requireAuth(authContext);

  // (2) Validação Zod ANTES de qualquer persistência (Req. 9.4, 9.5).
  const parsed = apiCreateTicketSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiValidationError(parsed.error);
  }
  const data = parsed.data;

  // (3) Monta o payload do TicketService — tenant NUNCA vem do corpo (Req. 9.1).
  const createFn = deps.createTicket ?? createTicket;
  return translateAuthz(() =>
    createFn(
      user,
      companyId, // tenant derivado do servidor (conta autenticada)
      {
        title: data.title,
        description: data.description,
        createdById: data.createdById,
        origin: ChannelType.API,
        ...(data.impact !== undefined ? { impact: data.impact } : {}),
        ...(data.urgency !== undefined ? { urgency: data.urgency } : {}),
        ...(data.unitId !== undefined ? { unitId: data.unitId } : {}),
        ...(data.departmentId !== undefined
          ? { departmentId: data.departmentId }
          : {}),
        ...(data.serviceId !== undefined ? { serviceId: data.serviceId } : {}),
        ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
        ...(data.subcategoryId !== undefined
          ? { subcategoryId: data.subcategoryId }
          : {}),
        ...(data.categoryItemId !== undefined
          ? { categoryItemId: data.categoryItemId }
          : {}),
        ...(data.queueId !== undefined ? { queueId: data.queueId } : {}),
        ...(data.teamId !== undefined ? { teamId: data.teamId } : {}),
        ...(data.assignedToId !== undefined
          ? { assignedToId: data.assignedToId }
          : {}),
      },
      deps.prisma ? { prisma: deps.prisma } : {},
    ),
  );
}

/**
 * Atualiza (status de) um ticket via API autenticada (Req. 9.1–9.6).
 *
 * Delega ao `TicketService.changeTicketStatus`, que autoriza no backend
 * (`ticket.update`) e escopa a atualização por tenant. O tenant vem sempre de
 * `authContext.companyId`.
 */
export async function updateTicketViaApi(
  authContext: ApiAuthContext | null | undefined,
  input: ApiUpdateTicketInput,
  deps: ApiAdapterDeps = {},
): Promise<ChangeStatusResult> {
  // (1) Autenticação (Req. 9.2).
  const { companyId, user } = requireAuth(authContext);

  // (2) Validação Zod (Req. 9.4, 9.5).
  const parsed = apiUpdateTicketSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiValidationError(parsed.error);
  }
  const data = parsed.data;

  // (3) Delegação — tenant do servidor; autorização e escopo no TicketService.
  const changeFn = deps.changeTicketStatus ?? changeTicketStatus;
  return translateAuthz(() =>
    changeFn(
      user,
      companyId,
      data.ticketId,
      data.status,
      deps.prisma ? { prisma: deps.prisma } : {},
    ),
  );
}

/** Valores válidos de status re-exportados por conveniência da borda. */
export { TicketStatus };
