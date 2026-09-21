/**
 * Testes do LgpdService (Req. 13.4, 13.5) — prisma MOCKADO.
 *
 * Cobre:
 *  - `exportPersonalData` retorna os dados do titular (user + conversas +
 *    mensagens + tickets) em objeto estruturado (Req. 13.4);
 *  - `erasePersonalData` ANONIMIZA a PII (conversas/mensagens/user) e PRESERVA
 *    os registros de `AuditLog` (nunca update/delete de audit), ainda gravando
 *    UM AuditLog da própria operação (Req. 13.5);
 *  - `purgeExpired` anonimiza conversas além do corte de retenção (Req. 13.3).
 *
 * _Requisitos: 13.4, 13.5, 13.3_
 */

import { describe, it, expect, vi } from "vitest";

import {
  exportPersonalData,
  erasePersonalData,
  purgeExpired,
  type LgpdPrisma,
} from "@/lib/lgpd/service";

const COMPANY = "c1";
const CONTACT = "+5511999998888";

/**
 * Fake de Prisma para o LgpdService. Mantém um "banco" em memória mínimo com
 * conversas/mensagens/tickets/user e uma trilha de auditoria que NUNCA deve ser
 * mutada — expomos spies para provar isso.
 */
function makeFake(opts?: {
  auditCount?: number;
  conversationUpdatedAt?: Date;
}) {
  const convId = "conv-1";

  const state = {
    conversation: {
      id: convId,
      companyId: COMPANY,
      contactExternalId: CONTACT,
      contactName: "João Titular",
      state: "OPEN",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: opts?.conversationUpdatedAt ?? new Date("2026-01-01T00:00:00Z"),
    },
    message: {
      id: "msg-1",
      companyId: COMPANY,
      conversationId: convId,
      direction: "INBOUND",
      type: "TEXT",
      body: "meu CPF é 000",
      mediaUrl: null as string | null,
      createdAt: new Date("2026-01-01T00:05:00Z"),
    },
    ticket: {
      id: "tk-1",
      companyId: COMPANY,
      number: 1,
      title: "Preciso de ajuda",
      status: "OPEN",
      conversationId: convId,
      createdAt: new Date("2026-01-01T00:06:00Z"),
    },
    user: {
      id: "user-1",
      companyId: COMPANY,
      name: "João Titular",
      email: "joao@cliente.com",
      phone: "+551133334444",
      mobile: "+5511999998888",
    },
  };

  const spies = {
    messageUpdateMany: vi.fn(),
    conversationUpdate: vi.fn(),
    userUpdate: vi.fn(),
    auditCreate: vi.fn(),
    auditUpdate: vi.fn(), // NUNCA deve ser chamado
    auditDelete: vi.fn(), // NUNCA deve ser chamado
  };

  const tx: LgpdPrisma = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: (async (fn: (t: LgpdPrisma) => unknown) => fn(tx)) as any,
    conversation: {
      findMany: (async (args: { where: { updatedAt?: { lt: Date } } }) => {
        // purgeExpired passa updatedAt.lt; export/erase filtram por contato.
        const cutoff = args.where.updatedAt?.lt;
        if (cutoff && state.conversation.updatedAt >= cutoff) return [];
        return [{ ...state.conversation }];
      }) as unknown as LgpdPrisma["conversation"]["findMany"],
      update: (async (args: unknown) => {
        spies.conversationUpdate(args);
        return { id: convId };
      }) as unknown as LgpdPrisma["conversation"]["update"],
    } as unknown as LgpdPrisma["conversation"],
    message: {
      findMany: (async () => [{ ...state.message }]) as unknown as LgpdPrisma["message"]["findMany"],
      updateMany: (async (args: unknown) => {
        spies.messageUpdateMany(args);
        return { count: 1 };
      }) as unknown as LgpdPrisma["message"]["updateMany"],
    } as unknown as LgpdPrisma["message"],
    ticket: {
      findMany: (async () => [{ ...state.ticket }]) as unknown as LgpdPrisma["ticket"]["findMany"],
    } as unknown as LgpdPrisma["ticket"],
    user: {
      findFirst: (async () => ({ ...state.user })) as unknown as LgpdPrisma["user"]["findFirst"],
      update: (async (args: unknown) => {
        spies.userUpdate(args);
        return { id: state.user.id };
      }) as unknown as LgpdPrisma["user"]["update"],
    } as unknown as LgpdPrisma["user"],
    auditLog: {
      count: (async () => opts?.auditCount ?? 3) as unknown as LgpdPrisma["auditLog"]["count"],
      create: (async (args: unknown) => {
        spies.auditCreate(args);
        return { id: "audit-new" };
      }) as unknown as LgpdPrisma["auditLog"]["create"],
      // Presentes só para provar que NÃO são chamados por LGPD.
      update: (async (args: unknown) => {
        spies.auditUpdate(args);
        return {};
      }) as unknown as never,
      delete: (async (args: unknown) => {
        spies.auditDelete(args);
        return {};
      }) as unknown as never,
    } as unknown as LgpdPrisma["auditLog"],
  } as unknown as LgpdPrisma;

  return { prisma: tx, spies, state };
}

describe("LgpdService.exportPersonalData (Req. 13.4)", () => {
  it("retorna os dados do titular em objeto estruturado", async () => {
    const { prisma } = makeFake();

    const data = await exportPersonalData(
      COMPANY,
      { contactExternalId: CONTACT, email: "joao@cliente.com", userId: "user-1" },
      { prisma },
    );

    expect(data.user?.email).toBe("joao@cliente.com");
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0].contactExternalId).toBe(CONTACT);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].body).toBe("meu CPF é 000");
    expect(data.tickets).toHaveLength(1);
    expect(data.tickets[0].number).toBe(1);
  });
});

describe("LgpdService.erasePersonalData (Req. 13.5)", () => {
  it("anonimiza PII e PRESERVA os registros de AuditLog (sem update/delete de audit)", async () => {
    const { prisma, spies } = makeFake({ auditCount: 3 });

    const res = await erasePersonalData(
      COMPANY,
      { contactExternalId: CONTACT, userId: "user-1" },
      { prisma, actorId: "admin-1", ip: "10.0.0.9" },
    );

    // Anonimização aplicada.
    expect(res.conversationsAnonymized).toBe(1);
    expect(res.messagesAnonymized).toBe(1);
    expect(res.usersAnonymized).toBe(1);

    // Mensagens: body/mediaUrl zerados.
    const msgArg = spies.messageUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(msgArg.data.body).toBeNull();
    expect(msgArg.data.mediaUrl).toBeNull();

    // Conversa: contato substituído por placeholder anon:, nome nulo.
    const convArg = spies.conversationUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(String(convArg.data.contactExternalId)).toMatch(/^anon:/);
    expect(convArg.data.contactName).toBeNull();

    // User: nome/e-mail/telefones anonimizados (e-mail mantém unicidade).
    const userArg = spies.userUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(userArg.data.name).toBe("Titular anonimizado");
    expect(String(userArg.data.email)).toMatch(/@example\.invalid$/);
    expect(userArg.data.phone).toBeNull();
    expect(userArg.data.mobile).toBeNull();

    // AUDITORIA PRESERVADA: contagem reportada e NENHUM update/delete de audit.
    expect(res.auditPreserved).toBe(3);
    expect(spies.auditUpdate).not.toHaveBeenCalled();
    expect(spies.auditDelete).not.toHaveBeenCalled();

    // A própria eliminação é auditada (append de UM AuditLog).
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe("lgpd.erase");
    // before/after sem PII (apenas contagens).
    expect(auditArg.data.after).toMatchObject({ usersAnonymized: 1 });
  });
});

describe("LgpdService.purgeExpired (Req. 13.3)", () => {
  it("anonimiza conversas além do corte de retenção e preserva auditoria", async () => {
    // Conversa antiga (2026-01-01); now bem depois ⇒ além do corte.
    const { prisma, spies } = makeFake();

    const res = await purgeExpired(
      COMPANY,
      { retentionDays: 30 },
      { prisma, now: new Date("2026-06-01T00:00:00Z") },
    );

    expect(res.conversationsAnonymized).toBe(1);
    expect(res.messagesAnonymized).toBe(1);
    expect(spies.auditUpdate).not.toHaveBeenCalled();
    expect(spies.auditDelete).not.toHaveBeenCalled();
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe("lgpd.purge");
  });

  it("não anonimiza conversas dentro do período de retenção", async () => {
    // Conversa recente relativa ao now ⇒ dentro do período (não expira).
    const { prisma, spies } = makeFake({
      conversationUpdatedAt: new Date("2026-05-20T00:00:00Z"),
    });

    const res = await purgeExpired(
      COMPANY,
      { retentionDays: 30 },
      { prisma, now: new Date("2026-06-01T00:00:00Z") },
    );

    expect(res.conversationsAnonymized).toBe(0);
    expect(res.messagesAnonymized).toBe(0);
    expect(spies.conversationUpdate).not.toHaveBeenCalled();
  });
});
