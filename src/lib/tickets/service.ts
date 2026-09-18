/**
 * TicketService — criação e transições de ciclo de vida de tickets.
 *
 * Tarefas 10.1 e 10.2. Fonte autoritativa:
 * `.kiro/specs/helpdesk-omnichannel/design.md` (seções "Data Models", "Motor de
 * SLA e Escalonamento", "Design de Baixo Nível") e requirements 4 e 12.
 *
 * Princípios invioláveis aplicados aqui:
 *  - `companyId` é SEMPRE derivado do servidor (contexto de tenant); NUNCA vem
 *    do corpo do cliente. Por isso `createTicket` recebe `companyId` como
 *    parâmetro separado do payload validado — o schema Zod nem sequer conhece
 *    `companyId`, então um `companyId` no corpo é literalmente ignorado.
 *  - Autorização SEMPRE no backend: `Authorization.assert` é chamado ANTES de
 *    qualquer efeito (validação de campos ocorre antes por ser barata e não ter
 *    efeitos colaterais, mas nenhuma escrita acontece sem a asserção passar).
 *  - Prioridade é DERIVADA (nunca escolhida) via `derivePriority`.
 *  - Numeração via `nextTicketNumber` DENTRO da mesma transação que cria o
 *    Ticket (atomicidade da reserva + uso).
 *
 * Decisão de projeto — SlaRule ausente (Req. 12.10):
 *   O requisito determina que, se a prioridade do ticket não tem `SlaRule` no
 *   momento da criação, o SlaEngine "rejeita o cálculo, preserva o ticket sem
 *   prazos definidos e sinaliza um erro indicando ausência de regra de SLA".
 *   Implementação escolhida (documentada):
 *     - Existe um caminho DEDICADO `computeSla(tx, companyId, priority, createdAt)`
 *       que LANÇA {@link SlaRuleMissingError} quando não há regra. Esse caminho é
 *       para chamadores que exigem prazos obrigatoriamente.
 *     - `createTicket` NÃO aborta a criação por falta de SLA: ele cria o ticket
 *       (preservando-o sem prazos, `slaResponseDeadline`/`slaResolutionDeadline`
 *       nulos) E sinaliza a ausência devolvendo `slaRuleMissing: true` no
 *       resultado (um sinal claro que o chamador pode inspecionar/logar). Assim
 *       o ticket é preservado sem prazos E o erro é sinalizado, exatamente como
 *       o texto do requisito descreve, sem perder o ticket.
 *   Racional: perder o ticket por ausência de regra de SLA seria pior para o
 *   negócio do que criá-lo sem prazos; o requisito fala em "preservar o ticket
 *   sem prazos". O sinal explícito permite que a borda alerte o operador.
 *
 * _Requisitos: 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 12.1, 12.10, 2.1, 2.7_
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { Impact, Priority, TicketStatus, Urgency } from "@/lib/domain/enums";
import type { ResourceRef, SessionUser } from "@/lib/domain/types";
import { ChannelType } from "@/lib/domain/enums";
import { derivePriority } from "@/lib/engines/priority";
import { calcSla } from "@/lib/engines/sla";
import { Authorization } from "@/lib/rbac/authorization";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { nextTicketNumber } from "@/lib/tickets/sequence";

/**
 * Erro sinalizado quando não existe `SlaRule` para a prioridade no momento do
 * cálculo de prazos (Req. 12.10). Lançado APENAS pelo caminho dedicado
 * {@link computeSla}; `createTicket` não o lança (ver decisão de projeto no
 * cabeçalho do módulo).
 */
export class SlaRuleMissingError extends Error {
  readonly code = "SLA_RULE_MISSING" as const;
  readonly priority: Priority;

  constructor(companyId: string, priority: Priority) {
    super(
      `Nenhuma SlaRule definida para a prioridade ${priority}; o ticket não recebe prazos de SLA`,
    );
    this.name = "SlaRuleMissingError";
    this.priority = priority;
    (this as { companyId?: string }).companyId = companyId;
    Object.setPrototypeOf(this, SlaRuleMissingError.prototype);
  }
}

/**
 * Erro de validação de entrada. Envolve o `ZodError` de origem, preservando as
 * `issues` (campo/motivo) para tradução em resposta `422`/`400` na borda, sem
 * persistir nada (Req. 4.4).
 */
export class TicketValidationError extends Error {
  readonly code = "TICKET_VALIDATION" as const;
  readonly issues: z.core.$ZodIssue[];

  constructor(error: z.ZodError) {
    super("Dados de ticket inválidos");
    this.name = "TicketValidationError";
    this.issues = error.issues;
    (this as { cause?: unknown }).cause = error;
    Object.setPrototypeOf(this, TicketValidationError.prototype);
  }
}

/**
 * Schema Zod da criação de ticket.
 *
 * NÃO inclui `companyId`: o tenant é sempre derivado do servidor e passado como
 * argumento separado. Limites conforme Req. 4.3: título 1–200, descrição
 * 1–5.000. Solicitante (`createdById`) obrigatório (Req. 4.4). Impacto/urgência
 * default MEDIUM (Req. 4.2). Origem default WEB (Req. 4.1). Demais campos de
 * classificação são opcionais.
 */
export const createTicketSchema = z.object({
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
  impact: z.enum(Impact).default(Impact.MEDIUM),
  urgency: z.enum(Urgency).default(Urgency.MEDIUM),
  origin: z.enum(ChannelType).default(ChannelType.WEB),
  // Campos de classificação opcionais (Req. 4.2).
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

/** Entrada bruta (pré-validação) de `createTicket`. */
export type CreateTicketInput = z.input<typeof createTicketSchema>;
/** Entrada validada/normalizada (com defaults aplicados). */
export type CreateTicketData = z.output<typeof createTicketSchema>;

/** Resultado de `createTicket`. */
export interface CreateTicketResult {
  ticketId: string;
  number: number;
  priority: Priority;
  status: TicketStatus;
  slaResponseDeadline: Date | null;
  slaResolutionDeadline: Date | null;
  /**
   * `true` quando não havia `SlaRule` para a prioridade e, portanto, o ticket
   * foi criado SEM prazos (Req. 12.10). Sinal explícito para a borda alertar.
   */
  slaRuleMissing: boolean;
}

/** Cliente Prisma mínimo do qual o serviço depende (facilita mock em teste). */
export type TicketPrisma = Pick<PrismaClient, "$transaction" | "slaRule">;

/** Valores válidos de status (Req. 4.6) — o conjunto fechado do enum. */
const VALID_STATUSES: ReadonlySet<string> = new Set<string>(
  Object.values(TicketStatus),
);

/**
 * Type guard fail-closed: reconhece um alvo de status legal (Req. 4.6).
 */
export function isValidTicketStatus(value: string): value is TicketStatus {
  return VALID_STATUSES.has(value);
}

/**
 * Constrói o `ResourceRef` de um ticket para as decisões de autorização.
 * Inclui os campos de escopo relevantes (unit/department/team/queue/category)
 * para que `Authorization` possa avaliar cobertura de escopo restrito.
 */
function ticketResourceRef(
  companyId: string,
  fields: Partial<{
    id: string;
    unitId: string;
    departmentId: string;
    teamId: string;
    queueId: string;
    categoryId: string;
  }>,
): ResourceRef {
  return {
    companyId,
    type: "ticket",
    id: fields.id,
    unitId: fields.unitId,
    departmentId: fields.departmentId,
    teamId: fields.teamId,
    queueId: fields.queueId,
    categoryId: fields.categoryId,
  };
}

/**
 * Caminho DEDICADO de cálculo de SLA que EXIGE regra (Req. 12.1, 12.10).
 *
 * Busca a `SlaRule` de (companyId, priority). Se existir, retorna os prazos via
 * `calcSla`. Se NÃO existir, LANÇA {@link SlaRuleMissingError} — o cálculo é
 * rejeitado e o erro é sinalizado. Este caminho não persiste nada.
 *
 * Aceita um executor (`tx` ou o próprio client) para poder rodar dentro ou fora
 * de transação.
 */
export async function computeSla(
  executor: Pick<PrismaClient, "slaRule">,
  companyId: string,
  priority: Priority,
  createdAt: Date,
): Promise<{ responseDeadline: Date; resolutionDeadline: Date }> {
  const rule = await executor.slaRule.findUnique({
    where: { companyId_priority: { companyId, priority } },
    select: { responseHours: true, resolutionHours: true },
  });
  if (!rule) {
    throw new SlaRuleMissingError(companyId, priority);
  }
  return calcSla(rule, createdAt);
}

/**
 * Cria um ticket sob o tenant `companyId` (derivado do servidor).
 *
 * Sequência (Req. 4.1–4.4, 4.7, 12.1, 12.10, 2.1, 2.7):
 *  1. Valida o payload com Zod → em falha, lança {@link TicketValidationError}
 *     e NÃO persiste (Req. 4.4).
 *  2. Autoriza no backend: `Authorization.assert(user, "ticket.create", ref)`
 *     ANTES de qualquer efeito (Req. 2.1, 2.7).
 *  3. Deriva a prioridade via `derivePriority` (Req. 4.7).
 *  4. Em UMA transação: reserva o número via `nextTicketNumber` e cria o Ticket
 *     com status OPEN (Req. 4.3, 4.5). Dentro da transação, tenta calcular os
 *     prazos de SLA; se não houver `SlaRule`, cria o ticket SEM prazos e marca
 *     `slaRuleMissing` (Req. 12.1, 12.10 — ver decisão no cabeçalho).
 *
 * @param user usuário da sessão (autorização no backend).
 * @param companyId tenant derivado do servidor (ctx.companyId) — NUNCA do corpo.
 * @param input payload do ticket (sem `companyId`).
 * @param deps injeção opcional do client Prisma (para testes).
 */
export async function createTicket(
  user: SessionUser,
  companyId: string,
  input: CreateTicketInput,
  deps: { prisma?: TicketPrisma } = {},
): Promise<CreateTicketResult> {
  const client = deps.prisma ?? (defaultPrisma as unknown as TicketPrisma);

  // (1) Validação de entrada — sem efeitos colaterais; falha não persiste nada.
  const parsed = createTicketSchema.safeParse(input);
  if (!parsed.success) {
    throw new TicketValidationError(parsed.error);
  }
  const data: CreateTicketData = parsed.data;

  // (2) Autorização no backend ANTES de qualquer escrita (Req. 2.1, 2.7).
  const ref = ticketResourceRef(companyId, {
    unitId: data.unitId,
    departmentId: data.departmentId,
    teamId: data.teamId,
    queueId: data.queueId,
    categoryId: data.categoryId,
  });
  Authorization.assert(user, "ticket.create", ref);

  // (3) Prioridade derivada (nunca escolhida).
  const priority = derivePriority(data.impact, data.urgency);

  // (4) Transação: número + criação + prazos de SLA (quando houver regra).
  return client.$transaction(async (tx) => {
    const number = await nextTicketNumber(tx, companyId);

    // Instante único de criação usado tanto no cálculo de SLA quanto no
    // createdAt persistido (coerência: prazos relativos ao mesmo instante).
    const createdAt = new Date();

    // SLA (Req. 12.1, 12.10): tenta calcular; ausência de regra → sem prazos.
    let slaResponseDeadline: Date | null = null;
    let slaResolutionDeadline: Date | null = null;
    let slaRuleMissing = false;
    try {
      const sla = await computeSla(
        tx as unknown as Pick<PrismaClient, "slaRule">,
        companyId,
        priority,
        createdAt,
      );
      slaResponseDeadline = sla.responseDeadline;
      slaResolutionDeadline = sla.resolutionDeadline;
    } catch (err) {
      if (err instanceof SlaRuleMissingError) {
        // Preserva o ticket sem prazos e sinaliza a ausência (Req. 12.10).
        slaRuleMissing = true;
      } else {
        throw err;
      }
    }

    const ticket = await tx.ticket.create({
      data: {
        number,
        companyId,
        title: data.title,
        description: data.description,
        status: TicketStatus.OPEN,
        impact: data.impact,
        urgency: data.urgency,
        priority,
        origin: data.origin,
        createdById: data.createdById,
        assignedToId: data.assignedToId ?? null,
        unitId: data.unitId ?? null,
        departmentId: data.departmentId ?? null,
        serviceId: data.serviceId ?? null,
        categoryId: data.categoryId ?? null,
        subcategoryId: data.subcategoryId ?? null,
        categoryItemId: data.categoryItemId ?? null,
        queueId: data.queueId ?? null,
        teamId: data.teamId ?? null,
        slaResponseDeadline,
        slaResolutionDeadline,
        createdAt,
      },
      select: { id: true, number: true, status: true },
    });

    return {
      ticketId: ticket.id,
      number: ticket.number,
      priority,
      status: ticket.status as TicketStatus,
      slaResponseDeadline,
      slaResolutionDeadline,
      slaRuleMissing,
    };
  });
}

/** Resultado de uma mudança de status. */
export interface ChangeStatusResult {
  ticketId: string;
  status: TicketStatus;
}

/** Cliente Prisma mínimo para a mudança de status. */
export type TicketStatusPrisma = Pick<PrismaClient, "ticket">;

/**
 * Altera o status de um ticket para um valor legal do enum (Req. 4.6, 2.1, 2.7).
 *
 *  1. Valida que `targetStatus` é um `TicketStatus` legal (fail-closed) — alvo
 *     inválido lança `RangeError` sem tocar o banco.
 *  2. Autoriza no backend: `Authorization.assert(user, "ticket.update", ref)`
 *     ANTES de qualquer efeito.
 *  3. Atualiza o status do ticket dentro do tenant (`companyId` do servidor).
 *
 * A atualização é escopada por `{ id, companyId }` para nunca cruzar tenants.
 */
export async function changeTicketStatus(
  user: SessionUser,
  companyId: string,
  ticketId: string,
  targetStatus: string,
  deps: { prisma?: TicketStatusPrisma } = {},
): Promise<ChangeStatusResult> {
  const client = deps.prisma ?? (defaultPrisma as unknown as TicketStatusPrisma);

  // (1) Alvo precisa ser um status legal do enum (Req. 4.6).
  if (!isValidTicketStatus(targetStatus)) {
    throw new RangeError(`Status de ticket inválido: ${targetStatus}`);
  }

  // (2) Autorização no backend ANTES de qualquer efeito (Req. 2.1, 2.7).
  const ref = ticketResourceRef(companyId, { id: ticketId });
  Authorization.assert(user, "ticket.update", ref);

  // (3) Atualização escopada por tenant.
  const updated = await client.ticket.update({
    where: { id: ticketId, companyId } as Prisma.TicketWhereUniqueInput,
    data: { status: targetStatus },
    select: { id: true, status: true },
  });

  return { ticketId: updated.id, status: updated.status as TicketStatus };
}
