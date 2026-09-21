/**
 * Property 10 — Auditoria completa (Req. 13.1).
 *
 * **Validates: Requisitos 13.1** — toda operação sensível bem-sucedida gera
 * EXATAMENTE UM `AuditLog` com `before`/`after` consistentes.
 *
 * Estratégia (unit, prisma MOCKADO): usamos `withAudit` para envolver uma
 * operação sensível representativa — uma mudança de status de ticket. O fake de
 * `$transaction` contabiliza cada `auditLog.create`. Para uma bateria de
 * entradas geradas por fast-check (status de origem/destino, actor, ip, ids),
 * asseguramos o invariante:
 *   - operação bem-sucedida ⇒ exatamente UM AuditLog gravado (count === 1);
 *   - `before.status`/`after.status` refletem EXATAMENTE a mudança;
 *   - operação que FALHA ⇒ ZERO AuditLog (transação revertida).
 *
 * _Requisitos: 13.1_
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { Prisma, PrismaClient } from "@prisma/client";
import { TicketStatus } from "@/lib/domain/enums";
import { withAudit } from "@/lib/audit/service";

const STATUSES = Object.values(TicketStatus);

/**
 * Fake de client com `$transaction`. Cada `auditLog.create` incrementa um
 * contador e guarda o `data` gravado. O `tx.ticket.update` simula a operação
 * sensível (troca de status) e devolve a linha atualizada.
 */
function makeClient() {
  const audits: Array<Record<string, unknown>> = [];

  const tx = {
    ticket: {
      update: (args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data;
        const where = (args as { where: Record<string, unknown> }).where;
        return Promise.resolve({ id: where.id, status: data.status });
      },
    },
    auditLog: {
      create: (args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data;
        audits.push(data);
        return Promise.resolve({
          id: `audit-${audits.length}`,
          createdAt: new Date(),
          actorId: null,
          before: null,
          after: null,
          ip: null,
          ...data,
        });
      },
    },
  };

  const client = {
    $transaction: async (fn: (t: typeof tx) => unknown) => {
      // Semântica de transação: se o callback lançar, nada "commita" — como o
      // fake só registra dentro do callback, um throw naturalmente impede o
      // create do audit (que só ocorre APÓS a operação sensível em withAudit).
      return fn(tx);
    },
  } as unknown as Pick<PrismaClient, "$transaction">;

  return { client, audits };
}

describe("Property 10: Auditoria completa (Req. 13.1)", () => {
  it("operação sensível bem-sucedida ⇒ exatamente UM AuditLog com before/after consistentes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...STATUSES),
        fc.constantFrom(...STATUSES),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
        fc.option(fc.ipV4(), { nil: null }),
        async (fromStatus, toStatus, ticketId, actorId, ip) => {
          const { client, audits } = makeClient();

          const { result, audit } = await withAudit(
            client,
            // Operação sensível: muda o status do ticket.
            async (tx) => {
              const updated = await (
                tx as unknown as Prisma.TransactionClient
              ).ticket.update({
                where: { id: ticketId, companyId: "c1" },
                data: { status: toStatus },
              });
              return updated as { id: string; status: string };
            },
            // Entrada de auditoria derivada do resultado real (before/after).
            (updated) => ({
              companyId: "c1",
              actorId,
              action: "ticket.status.change",
              entityType: "ticket",
              entityId: updated.id,
              before: { status: fromStatus },
              after: { status: updated.status },
              ip,
            }),
          );

          // EXATAMENTE UM AuditLog gravado.
          expect(audits.length).toBe(1);

          // before/after consistentes com a mudança real.
          const entry = audits[0];
          expect((entry.before as { status: string }).status).toBe(fromStatus);
          expect((entry.after as { status: string }).status).toBe(toStatus);
          expect(entry.entityId).toBe(ticketId);
          expect(entry.action).toBe("ticket.status.change");

          // O resultado da operação sensível reflete o destino.
          expect(result.status).toBe(toStatus);
          expect(audit.id).toBe("audit-1");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("operação sensível que FALHA ⇒ ZERO AuditLog (nada é auditado sem sucesso)", async () => {
    const { client, audits } = makeClient();

    await expect(
      withAudit(
        client,
        async () => {
          throw new Error("falha na operação sensível");
        },
        () => ({
          companyId: "c1",
          action: "ticket.status.change",
          entityType: "ticket",
          entityId: "tk-x",
          before: { status: TicketStatus.OPEN },
          after: { status: TicketStatus.CLOSED },
        }),
      ),
    ).rejects.toThrow("falha na operação sensível");

    // Nenhum AuditLog: o append só ocorre APÓS o sucesso da operação.
    expect(audits.length).toBe(0);
  });
});
