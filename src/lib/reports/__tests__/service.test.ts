/**
 * Testes unitários do ReportsService (tarefa 27.2).
 *
 * `ticket.groupBy/count/findMany` e `message.count` são mockados com dados
 * canned — sem I/O real. Cobrem:
 *  - cálculo do tempo de primeira resposta em minutos (Req. 15.2);
 *  - taxa de violação de SLA com 2 casas decimais (Req. 15.3);
 *  - filtragem por escopo restrito refletida no `where` (Req. 15.6);
 *  - período vazio → todas as métricas zeradas (Req. 15.8).
 *
 * _Requisitos: 15.2, 15.3, 15.6, 15.8_
 */

import { describe, expect, it, vi } from "vitest";
import {
  computeMetrics,
  firstResponseMinutes,
  round2,
  slaViolationRate,
  type ReportQuery,
  type ReportsClient,
} from "@/lib/reports/service";

const COMPANY = "co-1";
const PERIOD = {
  from: new Date("2026-01-01T00:00:00.000Z"),
  to: new Date("2026-02-01T00:00:00.000Z"),
};

function baseQuery(over: Partial<ReportQuery> = {}): ReportQuery {
  return { companyId: COMPANY, period: PERIOD, ...over };
}

/** Constrói um ReportsClient mockado; delegates sobrescrevíveis. */
function mockClient(over: {
  groupBy?: ReturnType<typeof vi.fn>;
  count?: ReturnType<typeof vi.fn>;
  findMany?: ReturnType<typeof vi.fn>;
  messageCount?: ReturnType<typeof vi.fn>;
}): ReportsClient {
  return {
    ticket: {
      groupBy: over.groupBy ?? vi.fn().mockResolvedValue([]),
      count: over.count ?? vi.fn().mockResolvedValue(0),
      findMany: over.findMany ?? vi.fn().mockResolvedValue([]),
    },
    message: {
      count: over.messageCount ?? vi.fn().mockResolvedValue(0),
    },
  } as unknown as ReportsClient;
}

describe("ReportsService.firstResponseMinutes", () => {
  it("calcula a média em minutos entre createdAt e firstResponseAt", async () => {
    // Ticket A: 30 min; Ticket B: 90 min → média 60.
    const findMany = vi.fn().mockResolvedValue([
      {
        createdAt: new Date("2026-01-05T10:00:00.000Z"),
        firstResponseAt: new Date("2026-01-05T10:30:00.000Z"),
      },
      {
        createdAt: new Date("2026-01-06T08:00:00.000Z"),
        firstResponseAt: new Date("2026-01-06T09:30:00.000Z"),
      },
    ]);
    const client = mockClient({ findMany });

    const result = await firstResponseMinutes(client, baseQuery());

    expect(result).toBe(60);
    // Só considera tickets com firstResponseAt (filtro not: null aplicado).
    expect(findMany.mock.calls[0][0].where.firstResponseAt).toEqual({
      not: null,
    });
  });

  it("período sem respostas → 0 (Req. 15.8)", async () => {
    const client = mockClient({ findMany: vi.fn().mockResolvedValue([]) });
    expect(await firstResponseMinutes(client, baseQuery())).toBe(0);
  });
});

describe("ReportsService.slaViolationRate", () => {
  it("calcula a taxa com 2 casas decimais (1 de 3 → 33.33%)", async () => {
    const count = vi.fn().mockResolvedValue(3);
    // 1 violado (resposta atrasada), 2 dentro do prazo.
    const findMany = vi.fn().mockResolvedValue([
      {
        firstResponseAt: new Date("2026-01-05T12:00:00.000Z"),
        slaResponseDeadline: new Date("2026-01-05T11:00:00.000Z"), // violado
        resolvedAt: null,
        slaResolutionDeadline: null,
      },
      {
        firstResponseAt: new Date("2026-01-05T10:00:00.000Z"),
        slaResponseDeadline: new Date("2026-01-05T11:00:00.000Z"), // ok
        resolvedAt: null,
        slaResolutionDeadline: null,
      },
      {
        firstResponseAt: null,
        slaResponseDeadline: new Date("2026-01-05T11:00:00.000Z"),
        resolvedAt: new Date("2026-01-05T10:00:00.000Z"),
        slaResolutionDeadline: new Date("2026-01-05T18:00:00.000Z"), // ok
      },
    ]);
    const client = mockClient({ count, findMany });

    const result = await slaViolationRate(client, baseQuery());

    expect(result).toBe(33.33);
  });

  it("conta violação por resolução atrasada", async () => {
    const count = vi.fn().mockResolvedValue(2);
    const findMany = vi.fn().mockResolvedValue([
      {
        firstResponseAt: null,
        slaResponseDeadline: null,
        resolvedAt: new Date("2026-01-05T20:00:00.000Z"),
        slaResolutionDeadline: new Date("2026-01-05T18:00:00.000Z"), // violado
      },
      {
        firstResponseAt: null,
        slaResponseDeadline: null,
        resolvedAt: new Date("2026-01-05T16:00:00.000Z"),
        slaResolutionDeadline: new Date("2026-01-05T18:00:00.000Z"), // ok
      },
    ]);
    const client = mockClient({ count, findMany });

    expect(await slaViolationRate(client, baseQuery())).toBe(50);
  });

  it("total 0 → 0.00 sem consultar findMany (Req. 15.8)", async () => {
    const findMany = vi.fn();
    const client = mockClient({
      count: vi.fn().mockResolvedValue(0),
      findMany,
    });

    expect(await slaViolationRate(client, baseQuery())).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("round2 arredonda meio para cima e permanece em [0,100]", () => {
    expect(round2(33.335)).toBe(33.34);
    expect(round2(100)).toBe(100);
    expect(round2(0)).toBe(0);
  });
});

describe("ReportsService escopo (Req. 15.6) e tenant (15.5)", () => {
  it("propaga companyId e filtros de escopo restrito para o where", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = mockClient({ findMany });

    await firstResponseMinutes(
      client,
      baseQuery({ scope: { queueIds: ["q-1"], assignedToIds: ["u-9"] } }),
    );

    const where = findMany.mock.calls[0][0].where;
    expect(where.companyId).toBe(COMPANY);
    expect(where.queueId).toEqual({ in: ["q-1"] });
    expect(where.assignedToId).toEqual({ in: ["u-9"] });
    // O período também é aplicado.
    expect(where.createdAt).toEqual({ gte: PERIOD.from, lt: PERIOD.to });
  });
});

describe("ReportsService.computeMetrics período vazio (Req. 15.8)", () => {
  it("retorna todas as métricas zeradas quando não há dados", async () => {
    const client = mockClient({
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      messageCount: vi.fn().mockResolvedValue(0),
    });

    const m = await computeMetrics(client, baseQuery());

    expect(m.totalTickets).toBe(0);
    expect(m.firstResponseMinutes).toBe(0);
    expect(m.slaViolationRate).toBe(0);
    // Todos os status presentes e zerados.
    expect(m.countByStatus.OPEN).toBe(0);
    expect(m.countByStatus.CLOSED).toBe(0);
    // Todos os canais presentes e zerados.
    expect(m.throughputByChannel.WHATSAPP).toBe(0);
    expect(m.throughputByChannel.EMAIL).toBe(0);
    // Sem filas → mapa vazio.
    expect(Object.keys(m.countByQueue)).toHaveLength(0);
  });

  it("countByStatus sobrepõe as contagens observadas sobre os zeros", async () => {
    const client = mockClient({
      groupBy: vi.fn().mockImplementation((args: { by: string[] }) => {
        if (args.by[0] === "status") {
          return Promise.resolve([
            { status: "OPEN", _count: { _all: 5 } },
            { status: "RESOLVED", _count: { _all: 2 } },
          ]);
        }
        return Promise.resolve([]);
      }),
      count: vi.fn().mockResolvedValue(7),
    });

    const m = await computeMetrics(client, baseQuery());
    expect(m.countByStatus.OPEN).toBe(5);
    expect(m.countByStatus.RESOLVED).toBe(2);
    expect(m.countByStatus.WAITING).toBe(0);
    expect(m.totalTickets).toBe(7);
  });
});
