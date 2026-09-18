/**
 * Testes unitários do TicketService (tarefa 10.3).
 *
 * PUROS: sem banco e sem NextAuth. O client Prisma é mockado (transação e
 * `slaRule`), de modo a exercitar a lógica de validação, prioridade derivada,
 * status inicial, tratamento de `SlaRule` ausente e AUTORIZAÇÃO no backend, sem
 * qualquer I/O real. Um teste de integração DB (create+número+SLA) vive em
 * `service.integration.test.ts`, guardado por `DATABASE_URL`.
 *
 * _Requisitos: 4.3, 4.4, 4.6, 4.7, 12.1, 12.10, 2.1, 2.7_
 */

import { describe, expect, it, vi } from "vitest";
import {
  ChannelType,
  Impact,
  Priority,
  Role,
  ScopeLevel,
  TicketStatus,
  Urgency,
} from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import { AuthorizationError } from "@/lib/rbac/types";
import {
  changeTicketStatus,
  computeSla,
  createTicket,
  isValidTicketStatus,
  SlaRuleMissingError,
  TicketValidationError,
  type CreateTicketInput,
  type TicketPrisma,
} from "@/lib/tickets/service";

const COMPANY = "company-1";

/** Usuário com permissão total no tenant (escopo TENANT). */
function authorizedUser(companyId = COMPANY): SessionUser {
  return {
    id: "u-agent",
    companyId,
    role: Role.AGENT,
    roleAssignments: [
      {
        permissions: ["ticket.create", "ticket.update"],
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
    ],
  };
}

/** Usuário SEM nenhuma permissão (sem atribuições) → negado por padrão. */
function unauthorizedUser(companyId = COMPANY): SessionUser {
  return { id: "u-none", companyId, role: Role.CLIENT, roleAssignments: [] };
}

/**
 * Mock de client Prisma para `createTicket`. `sequenceStart` controla o número
 * devolvido pela sequência; `slaRule` é o retorno de `findUnique` (null = sem
 * regra). Captura o `data` do `ticket.create` em `captured`.
 */
function mockPrisma(opts: {
  sequenceStart?: number;
  slaRule?: { responseHours: number; resolutionHours: number } | null;
}): { prisma: TicketPrisma; captured: { data?: Record<string, unknown> } } {
  const captured: { data?: Record<string, unknown> } = {};
  let counter = opts.sequenceStart ?? 1;

  const tx = {
    ticketSequence: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ next: counter + 1 })),
      update: vi.fn(async () => ({ next: ++counter + 1 })),
    },
    slaRule: {
      findUnique: vi.fn(async () => opts.slaRule ?? null),
    },
    ticket: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        captured.data = data;
        return {
          id: "ticket-generated-id",
          number: data.number,
          status: data.status,
        };
      }),
    },
  };

  const prisma = {
    slaRule: tx.slaRule,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  } as unknown as TicketPrisma;

  return { prisma, captured };
}

const baseInput: CreateTicketInput = {
  title: "Impressora não funciona",
  description: "A impressora do 3º andar parou.",
  createdById: "requester-1",
};

describe("createTicket — validação de campos obrigatórios (Req. 4.4)", () => {
  it("rejeita título ausente sem persistir", async () => {
    const { prisma } = mockPrisma({});
    await expect(
      createTicket(
        authorizedUser(),
        COMPANY,
        { ...baseInput, title: undefined as unknown as string },
        { prisma },
      ),
    ).rejects.toBeInstanceOf(TicketValidationError);
    expect((prisma.$transaction as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("rejeita descrição ausente sem persistir", async () => {
    const { prisma } = mockPrisma({});
    await expect(
      createTicket(
        authorizedUser(),
        COMPANY,
        { ...baseInput, description: "" },
        { prisma },
      ),
    ).rejects.toBeInstanceOf(TicketValidationError);
    expect(prisma.$transaction as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejeita solicitante (createdById) ausente sem persistir", async () => {
    const { prisma } = mockPrisma({});
    await expect(
      createTicket(
        authorizedUser(),
        COMPANY,
        { ...baseInput, createdById: "" },
        { prisma },
      ),
    ).rejects.toBeInstanceOf(TicketValidationError);
    expect(prisma.$transaction as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("empresa é sempre o companyId do servidor (nunca do corpo); um companyId no corpo é ignorado", async () => {
    const { prisma, captured } = mockPrisma({
      slaRule: { responseHours: 4, resolutionHours: 8 },
    });
    // Injeta um companyId ATACANTE no corpo — deve ser ignorado.
    const input = {
      ...baseInput,
      companyId: "company-ATTACKER",
    } as unknown as CreateTicketInput;
    const res = await createTicket(authorizedUser(), COMPANY, input, { prisma });
    expect(res.ticketId).toBe("ticket-generated-id");
    // Persistido com o companyId do servidor, não o do corpo.
    expect(captured.data?.companyId).toBe(COMPANY);
  });
});

describe("createTicket — limites de tamanho (Req. 4.3)", () => {
  it("aceita título com exatamente 200 caracteres", async () => {
    const { prisma } = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    await expect(
      createTicket(
        authorizedUser(),
        COMPANY,
        { ...baseInput, title: "a".repeat(200) },
        { prisma },
      ),
    ).resolves.toMatchObject({ status: TicketStatus.OPEN });
  });

  it("rejeita título com 201 caracteres", async () => {
    const { prisma } = mockPrisma({});
    await expect(
      createTicket(
        authorizedUser(),
        COMPANY,
        { ...baseInput, title: "a".repeat(201) },
        { prisma },
      ),
    ).rejects.toBeInstanceOf(TicketValidationError);
  });

  it("aceita descrição com exatamente 5.000 caracteres", async () => {
    const { prisma } = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    await expect(
      createTicket(
        authorizedUser(),
        COMPANY,
        { ...baseInput, description: "d".repeat(5000) },
        { prisma },
      ),
    ).resolves.toMatchObject({ status: TicketStatus.OPEN });
  });

  it("rejeita descrição com 5.001 caracteres", async () => {
    const { prisma } = mockPrisma({});
    await expect(
      createTicket(
        authorizedUser(),
        COMPANY,
        { ...baseInput, description: "d".repeat(5001) },
        { prisma },
      ),
    ).rejects.toBeInstanceOf(TicketValidationError);
  });
});

describe("createTicket — status inicial e prioridade derivada (Req. 4.3, 4.7)", () => {
  it("define status inicial OPEN", async () => {
    const { prisma, captured } = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    const res = await createTicket(authorizedUser(), COMPANY, baseInput, {
      prisma,
    });
    expect(res.status).toBe(TicketStatus.OPEN);
    expect(captured.data?.status).toBe(TicketStatus.OPEN);
  });

  it("aplica defaults MEDIUM de impacto/urgência → prioridade MEDIUM", async () => {
    const { prisma } = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    const res = await createTicket(authorizedUser(), COMPANY, baseInput, {
      prisma,
    });
    expect(res.priority).toBe(Priority.MEDIUM);
  });

  it("deriva CRITICAL de impacto HIGH × urgência HIGH", async () => {
    const { prisma } = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    const res = await createTicket(
      authorizedUser(),
      COMPANY,
      { ...baseInput, impact: Impact.HIGH, urgency: Urgency.HIGH },
      { prisma },
    );
    expect(res.priority).toBe(Priority.CRITICAL);
  });

  it("deriva LOW de impacto LOW × urgência LOW", async () => {
    const { prisma } = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    const res = await createTicket(
      authorizedUser(),
      COMPANY,
      { ...baseInput, impact: Impact.LOW, urgency: Urgency.LOW },
      { prisma },
    );
    expect(res.priority).toBe(Priority.LOW);
  });

  it("registra a origem (default WEB) e permite override", async () => {
    const { prisma, captured } = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    await createTicket(authorizedUser(), COMPANY, baseInput, { prisma });
    expect(captured.data?.origin).toBe(ChannelType.WEB);

    const second = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    await createTicket(
      authorizedUser(),
      COMPANY,
      { ...baseInput, origin: ChannelType.WHATSAPP },
      { prisma: second.prisma },
    );
    expect(second.captured.data?.origin).toBe(ChannelType.WHATSAPP);
  });
});

describe("createTicket — integração com SLA (Req. 12.1, 12.10)", () => {
  it("define prazos quando existe SlaRule para a prioridade", async () => {
    const { prisma, captured } = mockPrisma({
      slaRule: { responseHours: 4, resolutionHours: 8 },
    });
    const res = await createTicket(authorizedUser(), COMPANY, baseInput, {
      prisma,
    });
    expect(res.slaRuleMissing).toBe(false);
    expect(res.slaResponseDeadline).toBeInstanceOf(Date);
    expect(res.slaResolutionDeadline).toBeInstanceOf(Date);
    // resolutionDeadline >= responseDeadline (Req. 12.2, coerência).
    expect(res.slaResolutionDeadline!.getTime()).toBeGreaterThanOrEqual(
      res.slaResponseDeadline!.getTime(),
    );
    expect(captured.data?.slaResponseDeadline).toBeInstanceOf(Date);
  });

  it("SEM SlaRule: cria o ticket sem prazos e sinaliza slaRuleMissing (Req. 12.10)", async () => {
    const { prisma, captured } = mockPrisma({ slaRule: null });
    const res = await createTicket(authorizedUser(), COMPANY, baseInput, {
      prisma,
    });
    // Ticket preservado (criado) mas SEM prazos, com sinal explícito.
    expect(res.ticketId).toBe("ticket-generated-id");
    expect(res.slaRuleMissing).toBe(true);
    expect(res.slaResponseDeadline).toBeNull();
    expect(res.slaResolutionDeadline).toBeNull();
    expect(captured.data?.slaResponseDeadline).toBeNull();
    expect(captured.data?.slaResolutionDeadline).toBeNull();
  });
});

describe("computeSla — caminho dedicado que exige regra (Req. 12.10)", () => {
  it("lança SlaRuleMissingError quando não há regra", async () => {
    const executor = {
      slaRule: { findUnique: vi.fn(async () => null) },
    } as never;
    await expect(
      computeSla(executor, COMPANY, Priority.HIGH, new Date()),
    ).rejects.toBeInstanceOf(SlaRuleMissingError);
  });

  it("calcula prazos quando há regra", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const executor = {
      slaRule: {
        findUnique: vi.fn(async () => ({ responseHours: 2, resolutionHours: 6 })),
      },
    } as never;
    const sla = await computeSla(executor, COMPANY, Priority.HIGH, createdAt);
    expect(sla.responseDeadline.toISOString()).toBe(
      "2026-01-01T02:00:00.000Z",
    );
    expect(sla.resolutionDeadline.toISOString()).toBe(
      "2026-01-01T06:00:00.000Z",
    );
  });
});

describe("createTicket — autorização no backend (Req. 2.1, 2.7)", () => {
  it("nega usuário sem permissão ticket.create, mesmo que a UI permitisse", async () => {
    const { prisma } = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    await expect(
      createTicket(unauthorizedUser(), COMPANY, baseInput, { prisma }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // Nenhum efeito: a asserção falha ANTES da transação.
    expect(prisma.$transaction as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("nega quando o companyId do recurso difere do tenant do usuário", async () => {
    const { prisma } = mockPrisma({
      slaRule: { responseHours: 1, resolutionHours: 2 },
    });
    // Usuário do tenant A tentando criar sob o tenant B (companyId do servidor).
    await expect(
      createTicket(authorizedUser("company-A"), "company-B", baseInput, {
        prisma,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(prisma.$transaction as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("isValidTicketStatus (Req. 4.6)", () => {
  it("reconhece todos os status legais", () => {
    for (const s of Object.values(TicketStatus)) {
      expect(isValidTicketStatus(s)).toBe(true);
    }
  });

  it("rejeita valores fora do enum (fail-closed)", () => {
    expect(isValidTicketStatus("DONE")).toBe(false);
    expect(isValidTicketStatus("")).toBe(false);
    expect(isValidTicketStatus("open")).toBe(false);
  });
});

describe("changeTicketStatus — transições de ciclo de vida (Req. 4.6, 2.1, 2.7)", () => {
  function mockStatusPrisma() {
    const update = vi.fn(
      async ({ data }: { data: { status: string } }) => ({
        id: "t1",
        status: data.status,
      }),
    );
    return {
      prisma: { ticket: { update } } as never,
      update,
    };
  }

  it("atualiza para um status legal quando autorizado", async () => {
    const { prisma, update } = mockStatusPrisma();
    const res = await changeTicketStatus(
      authorizedUser(),
      COMPANY,
      "t1",
      TicketStatus.IN_PROGRESS,
      { prisma },
    );
    expect(res.status).toBe(TicketStatus.IN_PROGRESS);
    expect(update).toHaveBeenCalledOnce();
  });

  it("rejeita status inválido sem tocar o banco", async () => {
    const { prisma, update } = mockStatusPrisma();
    await expect(
      changeTicketStatus(authorizedUser(), COMPANY, "t1", "DONE", { prisma }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(update).not.toHaveBeenCalled();
  });

  it("nega usuário sem permissão ticket.update, mesmo com status válido", async () => {
    const { prisma, update } = mockStatusPrisma();
    await expect(
      changeTicketStatus(
        unauthorizedUser(),
        COMPANY,
        "t1",
        TicketStatus.RESOLVED,
        { prisma },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(update).not.toHaveBeenCalled();
  });
});
