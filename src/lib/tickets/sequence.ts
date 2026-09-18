/**
 * Numeração sequencial de tickets por tenant (transacional) — tarefa 9.1.
 *
 * `Ticket.number` é único por tenant (`@@unique([companyId, number])`) e é
 * gerado a partir da tabela `TicketSequence` (design, "Regras de validação";
 * Req. 4.5, 4.8, 4.9). Esta função reserva o próximo número de forma segura sob
 * concorrência: números são DISTINTOS e CONTÍGUOS por tenant.
 *
 * A operação deve rodar DENTRO de uma transação (`prisma.$transaction`) — o
 * cliente `tx` recebido é o `Prisma.TransactionClient`. Reservar o número na
 * mesma transação que cria o `Ticket` garante que a reserva e o uso são atômicos.
 *
 * Estratégia:
 *  1. `upsert` atômico na linha da sequência do tenant: cria com `next=2` e
 *     devolve 1 na primeira vez; caso já exista, incrementa `next` em 1 e
 *     devolve o valor ANTERIOR (o número reservado).
 *  2. Em colisão da constraint de unicidade (corrida de criação da própria
 *     linha da sequência), REPETE até 5 tentativas; persistindo o conflito,
 *     lança {@link TicketNumberingConflictError}.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`.
 * Requisitos: 4.5, 4.8, 4.9.
 */

import { Prisma } from "@prisma/client";

/** Número máximo de tentativas sob colisão antes de desistir. */
const MAX_ATTEMPTS = 5;

/**
 * Erro lançado quando não foi possível reservar um número de ticket após
 * esgotar as tentativas de retry sob concorrência (Req. 4.9).
 */
export class TicketNumberingConflictError extends Error {
  readonly code = "TICKET_NUMBERING_CONFLICT" as const;

  constructor(companyId: string, attempts: number) {
    super(
      `Não foi possível reservar um número de ticket para o tenant após ${attempts} tentativas`,
    );
    this.name = "TicketNumberingConflictError";
    // companyId fica disponível para logs/telemetria sem PII sensível.
    (this as { companyId?: string }).companyId = companyId;
    Object.setPrototypeOf(this, TicketNumberingConflictError.prototype);
  }
}

/**
 * Detecta uma violação de unicidade do Prisma (P2002) — a corrida que pode
 * ocorrer quando duas transações tentam CRIAR a linha da sequência ao mesmo
 * tempo. Nesse caso, a retentativa cai no caminho de `update` (a linha já existe).
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/**
 * Reserva e devolve o próximo número de ticket para `companyId`, dentro de `tx`.
 *
 * Garante numeração distinta e contígua por tenant sob concorrência. Deve ser
 * chamada dentro de `prisma.$transaction`.
 *
 * @param tx cliente de transação do Prisma (`Prisma.TransactionClient`).
 * @param companyId tenant para o qual reservar o número (derivado do servidor).
 * @returns o número reservado (>= 1), único dentro do tenant.
 * @throws {TicketNumberingConflictError} se colidir após {@link MAX_ATTEMPTS}.
 */
export async function nextTicketNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<number> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Upsert atômico: se a linha existe, incrementa `next` e devolve o valor
      // ANTERIOR (o número reservado). Se não existe, cria com next=2 e reserva 1.
      const existing = await tx.ticketSequence.findUnique({
        where: { companyId },
        select: { next: true },
      });

      if (existing) {
        // Incremento atômico da linha existente; `next` era o número a reservar.
        const updated = await tx.ticketSequence.update({
          where: { companyId },
          data: { next: { increment: 1 } },
          select: { next: true },
        });
        // `updated.next` já foi incrementado; o número reservado é o anterior.
        return updated.next - 1;
      }

      // Primeira vez para este tenant: reserva o número 1 e deixa próximo = 2.
      // Se outra transação criar a linha em paralelo, o create colide (P2002)
      // e caímos no retry, onde a linha já existirá (caminho de update acima).
      await tx.ticketSequence.create({
        data: { companyId, next: 2 },
      });
      return 1;
    } catch (err) {
      lastError = err;
      if (isUniqueViolation(err)) {
        // Corrida na criação da linha da sequência: tentar de novo.
        continue;
      }
      // Erro não relacionado a colisão de unicidade: propaga imediatamente.
      throw err;
    }
  }

  // Esgotadas as tentativas de retry: sinaliza conflito de numeração (Req. 4.9).
  const conflict = new TicketNumberingConflictError(companyId, MAX_ATTEMPTS);
  if (lastError !== undefined) {
    (conflict as { cause?: unknown }).cause = lastError;
  }
  throw conflict;
}
