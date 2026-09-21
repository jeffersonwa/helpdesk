/**
 * Outbox dispatcher — enfileiramento transacional de `OutboxEvent` (tarefa 23.1).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seções "Outbox transacional" e "Motor de SLA e Escalonamento") e
 * requirements 17.1.
 *
 * Princípio (design, princípio 4): mudanças de estado e efeitos externos são
 * gravados NA MESMA TRANSAÇÃO e processados por workers idempotentes. Por isso o
 * `enqueue` recebe um "client" transacional (`tx`) — o `OutboxEvent` só existe se
 * a transação de domínio confirmar; se ela reverter, nenhum efeito é agendado
 * (nunca há efeito órfão nem estado sem efeito).
 *
 * Um `OutboxEvent` recém-enfileirado nasce em `PENDING`, com `attempts=0` e
 * `nextRunAt=now` (Req. 17.1) — os defaults do schema já cobrem isso, mas
 * `nextRunAt` é definido explicitamente para permitir injeção de relógio.
 *
 * _Requisitos: 17.1, 17.4, 17.5, 17.6_
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { OutboxState } from "@/lib/domain/enums";
import { prisma as defaultPrisma } from "@/lib/prisma";

/**
 * Cliente mínimo capaz de criar um `OutboxEvent`. Compatível tanto com o
 * `PrismaClient` completo quanto com o `tx` de `$transaction` (que expõe os
 * mesmos delegates de modelo).
 */
export interface OutboxCapableClient {
  outboxEvent: {
    create(args: {
      data: Prisma.OutboxEventUncheckedCreateInput;
    }): Promise<{ id: string }>;
  };
}

/** Dados necessários para enfileirar um evento no outbox. */
export interface EnqueueInput {
  companyId: string;
  /** Ex.: "whatsapp.send", "webhook.dispatch". */
  type: string;
  payload: Prisma.InputJsonValue;
}

/**
 * Enfileira um `OutboxEvent` usando o client fornecido (`tx` ou `prisma`).
 *
 * Passe o `tx` de uma `$transaction` para tornar o enfileiramento atômico com a
 * mudança de estado de domínio (padrão outbox transacional). O evento nasce
 * `PENDING`, `attempts=0`, `nextRunAt=now`.
 *
 * @returns o id do `OutboxEvent` criado.
 */
export async function enqueue(
  client: OutboxCapableClient,
  input: EnqueueInput,
  now: () => Date = () => new Date(),
): Promise<string> {
  const event = await client.outboxEvent.create({
    data: {
      companyId: input.companyId,
      type: input.type,
      payload: input.payload,
      state: OutboxState.PENDING,
      attempts: 0,
      nextRunAt: now(),
    },
  });
  return event.id;
}

/**
 * Conveniência não transacional: enfileira usando o `prisma` padrão.
 *
 * Use apenas quando NÃO houver uma transação de domínio à qual acoplar o
 * enfileiramento (ex.: um disparo de webhook autônomo). Quando existir uma
 * mudança de estado correlata, prefira {@link enqueue} dentro do `$transaction`.
 */
export function enqueueOutbox(
  input: EnqueueInput,
  deps: { prisma?: OutboxCapableClient; now?: () => Date } = {},
): Promise<string> {
  const client =
    deps.prisma ?? (defaultPrisma as unknown as OutboxCapableClient);
  return enqueue(client, input, deps.now);
}

/** Reexport de conveniência do tipo do client completo, para chamadores. */
export type { PrismaClient };
