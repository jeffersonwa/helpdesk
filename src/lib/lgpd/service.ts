/**
 * LGPD service — direitos do titular (exportação/eliminação) e retenção.
 *
 * Tarefa 25.2. Fonte autoritativa:
 * `.kiro/specs/helpdesk-omnichannel/design.md` (seção "Auditoria e LGPD") e
 * requirement 13 (LGPD).
 *
 * Escopo do módulo:
 *  - `exportPersonalData` — reúne, em objeto estruturado, os dados pessoais de
 *    um titular (por identificador de contato/e-mail) para entrega ao titular
 *    (Req. 13.4).
 *  - `erasePersonalData` — ANONIMIZA os dados pessoais do titular PRESERVANDO os
 *    registros de auditoria exigidos por obrigação legal (Req. 13.5).
 *  - `purgeExpired` — rotina de retenção: anonimiza dados pessoais além do
 *    período de retenção do tenant (Req. 13.3).
 *
 * Tudo é escopado por `companyId` (tenant do servidor) e recebe `prisma`
 * injetado. Não é super-elaborado: cobre corretamente contatos de
 * conversas/mensagens/tickets e o usuário-titular, quando aplicável.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ABORDAGEM DE ANONIMIZAÇÃO (documentada):
 *
 *  - PRESERVA a INTEGRIDADE REFERENCIAL: não deletamos linhas de
 *    conversas/mensagens/tickets (isso quebraria FKs e a própria trilha de
 *    auditoria que as referencia). Em vez disso, SUBSTITUÍMOS os campos de PII
 *    por PLACEHOLDERS determinísticos e não reversíveis:
 *      * `Conversation.contactExternalId` → `anon:<hash-curto>` (mantém unicidade
 *        por conversa sem revelar o telefone/e-mail original);
 *      * `Conversation.contactName`       → null;
 *      * `Message.body`/`Message.mediaUrl`→ null (conteúdo é PII do titular);
 *      * `User` (quando o titular é um usuário): `name` → "Titular anonimizado",
 *        `email` → `anon+<id>@example.invalid` (mantém a constraint @unique),
 *        `phone`/`mobile` → null. A senha NÃO é tocada aqui (não é PII exportável
 *        e a conta pode ser separadamente desativada).
 *
 *  - PRESERVA a AUDITORIA: `AuditLog` NÃO é alterado nem removido — é a trilha
 *    imutável exigida por obrigação legal (Req. 13.2, 13.5). A anonimização
 *    registra sua PRÓPRIA operação em auditoria (append-only), como qualquer
 *    operação sensível.
 *
 *  - O `subjectRef` é o identificador do contato (telefone E.164 do WhatsApp ou
 *    e-mail) OU o `userId` do titular quando ele é um usuário do tenant.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * _Requisitos: 13.3, 13.4, 13.5, 13.6, 13.7_
 */

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { recordAudit, type AuditWriter } from "@/lib/audit/service";

/**
 * Referência ao titular dos dados. Pelo menos um identificador deve ser dado.
 *  - `contactExternalId`: telefone (E.164) ou e-mail usado nas conversas;
 *  - `email`: e-mail do titular (também casa `User.email`);
 *  - `userId`: id do usuário-titular no tenant (quando aplicável).
 */
export interface SubjectRef {
  contactExternalId?: string;
  email?: string;
  userId?: string;
}

/** Dados pessoais exportados de um titular, em formato estruturado. */
export interface PersonalDataExport {
  subject: SubjectRef;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    mobile: string | null;
  } | null;
  conversations: Array<{
    id: string;
    contactExternalId: string;
    contactName: string | null;
    state: string;
    createdAt: Date;
  }>;
  messages: Array<{
    id: string;
    conversationId: string;
    direction: string;
    type: string;
    body: string | null;
    mediaUrl: string | null;
    createdAt: Date;
  }>;
  tickets: Array<{
    id: string;
    number: number;
    title: string;
    status: string;
    createdAt: Date;
  }>;
}

/** Resultado de `erasePersonalData` / `purgeExpired`. */
export interface ErasureResult {
  conversationsAnonymized: number;
  messagesAnonymized: number;
  usersAnonymized: number;
  /** Registros de auditoria PRESERVADOS (nunca tocados) — informativo. */
  auditPreserved: number;
}

/** Cliente Prisma mínimo do qual o serviço LGPD depende. */
export type LgpdPrisma = Pick<
  PrismaClient,
  "$transaction" | "user" | "conversation" | "message" | "ticket" | "auditLog"
>;

/** Placeholder determinístico (não reversível) para um identificador de contato. */
function anonContactId(original: string): string {
  const short = createHash("sha256").update(original).digest("hex").slice(0, 12);
  return `anon:${short}`;
}

/**
 * Resolve os `conversationId`s do tenant que pertencem ao titular, por
 * identificador de contato. Usado tanto na exportação quanto na eliminação.
 */
async function subjectConversationIds(
  client: LgpdPrisma,
  companyId: string,
  contactExternalId: string,
): Promise<string[]> {
  const rows = await client.conversation.findMany({
    where: { companyId, contactExternalId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Exporta os dados pessoais do titular em objeto estruturado (Req. 13.4).
 *
 * Reúne, escopado por tenant:
 *  - o `User` titular (se `email`/`userId` casar um usuário do tenant);
 *  - as `Conversation`s do contato e suas `Message`s;
 *  - os `Ticket`s vinculados a essas conversas.
 *
 * Não altera nada; é uma leitura pura para entrega ao titular.
 */
export async function exportPersonalData(
  companyId: string,
  subject: SubjectRef,
  deps: { prisma?: LgpdPrisma } = {},
): Promise<PersonalDataExport> {
  const client = deps.prisma ?? (defaultPrisma as unknown as LgpdPrisma);

  // Usuário-titular (por id ou e-mail), sempre escopado por tenant.
  let user: PersonalDataExport["user"] = null;
  if (subject.userId || subject.email) {
    const u = await client.user.findFirst({
      where: {
        companyId,
        ...(subject.userId ? { id: subject.userId } : {}),
        ...(subject.email ? { email: subject.email } : {}),
      },
      select: { id: true, name: true, email: true, phone: true, mobile: true },
    });
    user = u ?? null;
  }

  // Conversas/mensagens/tickets por identificador de contato.
  const contactId = subject.contactExternalId ?? subject.email;
  let conversations: PersonalDataExport["conversations"] = [];
  let messages: PersonalDataExport["messages"] = [];
  let tickets: PersonalDataExport["tickets"] = [];

  if (contactId) {
    const convs = await client.conversation.findMany({
      where: { companyId, contactExternalId: contactId },
      select: {
        id: true,
        contactExternalId: true,
        contactName: true,
        state: true,
        createdAt: true,
      },
    });
    conversations = convs;

    const convIds = convs.map((c) => c.id);
    if (convIds.length > 0) {
      messages = await client.message.findMany({
        where: { companyId, conversationId: { in: convIds } },
        select: {
          id: true,
          conversationId: true,
          direction: true,
          type: true,
          body: true,
          mediaUrl: true,
          createdAt: true,
        },
      });
      tickets = await client.ticket.findMany({
        where: { companyId, conversationId: { in: convIds } },
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          createdAt: true,
        },
      });
    }
  }

  return { subject, user, conversations, messages, tickets };
}

/**
 * Anonimiza os dados pessoais do titular PRESERVANDO a auditoria (Req. 13.5).
 *
 * Em UMA transação:
 *  - substitui PII de `Conversation`/`Message` do contato por placeholders/null;
 *  - anonimiza o `User` titular (nome/e-mail/telefones) quando aplicável;
 *  - NÃO toca `AuditLog` (trilha imutável preservada por obrigação legal);
 *  - grava UM `AuditLog` desta própria operação (append-only).
 *
 * Retorna contagens do que foi anonimizado + total de auditorias preservadas.
 */
export async function erasePersonalData(
  companyId: string,
  subject: SubjectRef,
  deps: { prisma?: LgpdPrisma; actorId?: string | null; ip?: string | null } = {},
): Promise<ErasureResult> {
  const client = deps.prisma ?? (defaultPrisma as unknown as LgpdPrisma);
  const contactId = subject.contactExternalId ?? subject.email;

  return client.$transaction(async (tx) => {
    let conversationsAnonymized = 0;
    let messagesAnonymized = 0;
    let usersAnonymized = 0;

    if (contactId) {
      const convIds = await subjectConversationIds(
        tx as unknown as LgpdPrisma,
        companyId,
        contactId,
      );

      if (convIds.length > 0) {
        // Mensagens: zera conteúdo (body/mediaUrl são PII do titular).
        const msgRes = await tx.message.updateMany({
          where: { companyId, conversationId: { in: convIds } },
          data: { body: null, mediaUrl: null },
        });
        messagesAnonymized = msgRes.count;

        // Conversas: placeholder no identificador + nome nulo.
        for (const id of convIds) {
          await tx.conversation.update({
            where: { id },
            data: {
              contactExternalId: anonContactId(`${id}:${contactId}`),
              contactName: null,
            },
          });
        }
        conversationsAnonymized = convIds.length;
      }
    }

    // Usuário-titular (por id ou e-mail), escopado por tenant.
    if (subject.userId || subject.email) {
      const u = await tx.user.findFirst({
        where: {
          companyId,
          ...(subject.userId ? { id: subject.userId } : {}),
          ...(subject.email ? { email: subject.email } : {}),
        },
        select: { id: true },
      });
      if (u) {
        await tx.user.update({
          where: { id: u.id },
          data: {
            name: "Titular anonimizado",
            // Mantém a constraint @unique de e-mail com um valor não-PII.
            email: `anon+${u.id}@example.invalid`,
            phone: null,
            mobile: null,
          },
        });
        usersAnonymized = 1;
      }
    }

    // Auditoria PRESERVADA: apenas contamos (nunca alteramos/removemos).
    const auditPreserved = await tx.auditLog.count({ where: { companyId } });

    // Grava UM AuditLog desta própria operação sensível (append-only).
    await recordAudit(tx as unknown as AuditWriter, {
      companyId,
      actorId: deps.actorId ?? null,
      action: "lgpd.erase",
      entityType: "dataSubject",
      entityId: contactId ?? subject.userId ?? "unknown",
      // before/after já sanitizados: apenas contagens, sem PII.
      before: null,
      after: {
        conversationsAnonymized,
        messagesAnonymized,
        usersAnonymized,
      },
      ip: deps.ip ?? null,
    });

    return {
      conversationsAnonymized,
      messagesAnonymized,
      usersAnonymized,
      auditPreserved,
    };
  });
}

/** Política de retenção por tenant (dados além de `retentionDays` expiram). */
export interface RetentionPolicy {
  retentionDays: number;
}

/**
 * Rotina de retenção (Req. 13.3): anonimiza dados pessoais de conversas cuja
 * atividade é anterior ao corte de retenção do tenant.
 *
 * Estratégia: seleciona conversas com `updatedAt < now - retentionDays` e
 * aplica a MESMA anonimização de `erasePersonalData` (placeholder no contato,
 * nome nulo, conteúdo de mensagens zerado), preservando integridade referencial
 * e a auditoria. Grava um `AuditLog` do expurgo.
 */
export async function purgeExpired(
  companyId: string,
  policy: RetentionPolicy,
  deps: { prisma?: LgpdPrisma; now?: Date; actorId?: string | null } = {},
): Promise<ErasureResult> {
  const client = deps.prisma ?? (defaultPrisma as unknown as LgpdPrisma);
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - policy.retentionDays * 86_400_000);

  return client.$transaction(async (tx) => {
    const expired = await tx.conversation.findMany({
      where: { companyId, updatedAt: { lt: cutoff } },
      select: { id: true, contactExternalId: true },
    });
    const convIds = expired.map((c) => c.id);

    let messagesAnonymized = 0;
    if (convIds.length > 0) {
      const msgRes = await tx.message.updateMany({
        where: { companyId, conversationId: { in: convIds } },
        data: { body: null, mediaUrl: null },
      });
      messagesAnonymized = msgRes.count;

      for (const c of expired) {
        await tx.conversation.update({
          where: { id: c.id },
          data: {
            contactExternalId: anonContactId(`${c.id}:${c.contactExternalId}`),
            contactName: null,
          },
        });
      }
    }

    const auditPreserved = await tx.auditLog.count({ where: { companyId } });

    await recordAudit(tx as unknown as AuditWriter, {
      companyId,
      actorId: deps.actorId ?? null,
      action: "lgpd.purge",
      entityType: "retention",
      entityId: `cutoff:${cutoff.toISOString()}`,
      before: null,
      after: {
        conversationsAnonymized: convIds.length,
        messagesAnonymized,
        retentionDays: policy.retentionDays,
      },
      ip: null,
    });

    return {
      conversationsAnonymized: convIds.length,
      messagesAnonymized,
      usersAnonymized: 0,
      auditPreserved,
    };
  });
}

/** Superfície pública do serviço LGPD. */
export const LgpdService = {
  exportPersonalData,
  erasePersonalData,
  purgeExpired,
} as const;
