"use server";

/**
 * Server Actions de Tickets do console (tarefa 33.1).
 *
 * Cria tickets reutilizando `tickets/service.createTicket`, que DERIVA a
 * prioridade (matriz impacto × urgência), reserva o número sequencial e calcula
 * os prazos de SLA — mantendo o comportamento canônico do backend.
 *
 * SEGURANÇA:
 *  - `companyId` e `createdById` (solicitante) SEMPRE derivados da sessão do
 *    servidor via {@link currentSessionUser}; nunca do form. (Req. 1.1–1.3, 4.4)
 *  - `Authorization.assert(user, "ticket.create", ...)` é aplicada dentro do
 *    serviço ANTES de qualquer efeito. (Req. 2.1, 2.2)
 *  - A prioridade NÃO é escolhida pelo cliente: é derivada de impacto/urgência.
 *
 * _Requisitos: 4.1, 4.2, 4.7, 2.1, 2.2, 1.3_
 */

import { revalidatePath } from "next/cache";
import { currentSessionUser } from "@/lib/rbac/session-user";
import { AuthorizationError } from "@/lib/rbac/types";
import { Impact, Urgency } from "@/lib/domain/enums";
import {
  createTicket,
  TicketValidationError,
} from "@/lib/tickets/service";

export type CreateTicketActionResult =
  | { ok: true; ticketId: string; number: number }
  | { ok: false; error: string };

/** Campos aceitos pelo formulário do console (classificação additiva). */
export interface CreateTicketFormInput {
  title: string;
  description: string;
  impact?: string;
  urgency?: string;
  unitId?: string;
  departmentId?: string;
  serviceId?: string;
  categoryId?: string;
  subcategoryId?: string;
  categoryItemId?: string;
  queueId?: string;
  teamId?: string;
}

/** Converte string do form em enum, com fallback MEDIUM. */
function toImpact(v?: string): Impact {
  return (Object.values(Impact) as string[]).includes(v ?? "") ? (v as Impact) : Impact.MEDIUM;
}
function toUrgency(v?: string): Urgency {
  return (Object.values(Urgency) as string[]).includes(v ?? "") ? (v as Urgency) : Urgency.MEDIUM;
}
/** Normaliza string opcional em `undefined` quando vazia. */
function opt(v?: string): string | undefined {
  return v && v.trim().length > 0 ? v : undefined;
}

export async function createTicketAction(
  input: CreateTicketFormInput,
): Promise<CreateTicketActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };

  try {
    const result = await createTicket(user, user.companyId, {
      title: input.title,
      description: input.description,
      // Solicitante derivado do servidor (Req. 4.4): o próprio usuário logado.
      createdById: user.id,
      impact: toImpact(input.impact),
      urgency: toUrgency(input.urgency),
      unitId: opt(input.unitId),
      departmentId: opt(input.departmentId),
      serviceId: opt(input.serviceId),
      categoryId: opt(input.categoryId),
      subcategoryId: opt(input.subcategoryId),
      categoryItemId: opt(input.categoryItemId),
      queueId: opt(input.queueId),
      teamId: opt(input.teamId),
    });
    revalidatePath("/tickets");
    return { ok: true, ticketId: result.ticketId, number: result.number };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: "Você não tem permissão para criar tickets." };
    }
    if (err instanceof TicketValidationError) {
      const first = err.issues[0];
      return { ok: false, error: first?.message ?? "Dados do ticket inválidos." };
    }
    return { ok: false, error: "Erro ao criar ticket." };
  }
}
