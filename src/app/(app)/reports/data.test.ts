/**
 * Testes do carregamento de dados de relatório (tarefa 35.2). Leves, sem render:
 * exercitam `loadReport` com `ReportsClient` e `SessionUserClient` mockados e
 * uma sessão injetada.
 *
 * Cobre:
 *  - restrição por tenant: todo `where` de ticket carrega o `companyId` da
 *    sessão (Req. 15.5);
 *  - restrição por escopo: usuário AGENT com escopo de fila limita as consultas
 *    às filas cobertas (Req. 15.6);
 *  - período vazio: sem dados → métricas zeradas (Req. 15.8);
 *  - falha no cálculo → estado de erro preservando o período (Req. 15.7).
 */
import { describe, it, expect, vi } from "vitest";
import { loadReport } from "./data";
import type { ReportsClient } from "@/lib/reports/service";
import type { SessionUserClient } from "@/lib/rbac/session-user";

/** Sessão injetada (id/companyId/role vêm sempre do servidor). */
function sessionFor(id: string, companyId: string, role: string) {
  return async () => ({ user: { id, companyId, role } });
}

/**
 * SessionUserClient mockado: devolve as `roleAssignment` materializadas do
 * usuário (permissões + escopos), como o Prisma faria.
 */
function makeSessionUserClient(
  assignments: Array<{ permissions: string[]; scopes: { level: string; refId: string | null }[] }>,
): SessionUserClient {
  const findMany = vi.fn(async () =>
    assignments.map((a) => ({
      roleDef: { permissions: a.permissions.map((action) => ({ action })) },
      scopes: a.scopes,
    })),
  );
  return { roleAssignment: { findMany } } as unknown as SessionUserClient;
}

/**
 * ReportsClient mockado que registra os `where` recebidos e devolve conjuntos
 * vazios (período/escopo sem dados). Suficiente para validar isolamento/escopo
 * e o comportamento de período vazio zerado.
 */
function makeEmptyReportsClient(): { client: ReportsClient; wheres: any[] } {
  const wheres: any[] = [];
  const record = (args: any) => {
    if (args?.where) wheres.push(args.where);
  };
  const client = {
    ticket: {
      groupBy: vi.fn(async (args: any) => {
        record(args);
        return [];
      }),
      count: vi.fn(async (args: any) => {
        record(args);
        return 0;
      }),
      findMany: vi.fn(async (args: any) => {
        record(args);
        return [];
      }),
    },
    message: {
      count: vi.fn(async (args: any) => {
        record(args);
        return 0;
      }),
    },
  } as unknown as ReportsClient;
  return { client, wheres };
}

describe("loadReport (carregamento de relatório do console)", () => {
  it("restringe todas as consultas ao companyId da sessão", async () => {
    const { client, wheres } = makeEmptyReportsClient();
    const sessionUserClient = makeSessionUserClient([
      { permissions: ["report.view"], scopes: [{ level: "TENANT", refId: null }] },
    ]);

    const res = await loadReport("30d", {
      reports: client,
      sessionUserClient,
      getSession: sessionFor("u1", "tenant-A", "ADMIN"),
    });

    expect(res.ok).toBe(true);
    // Todo where de ticket carrega o companyId da sessão.
    const ticketWheres = wheres.filter((w) => "companyId" in w);
    expect(ticketWheres.length).toBeGreaterThan(0);
    for (const w of ticketWheres) {
      expect(w.companyId).toBe("tenant-A");
    }
  });

  it("aplica o escopo de fila do usuário (escopo restrito)", async () => {
    const { client, wheres } = makeEmptyReportsClient();
    // AGENT (não admin) com escopo restrito a uma fila.
    const sessionUserClient = makeSessionUserClient([
      { permissions: ["report.view"], scopes: [{ level: "QUEUE", refId: "queue-1" }] },
    ]);

    const res = await loadReport("7d", {
      reports: client,
      sessionUserClient,
      getSession: sessionFor("u2", "tenant-B", "AGENT"),
    });

    expect(res.ok).toBe(true);
    // Ao menos um where restringe queueId às filas cobertas pelo escopo.
    const scoped = wheres.filter((w) => w.queueId?.in);
    expect(scoped.length).toBeGreaterThan(0);
    for (const w of scoped) {
      expect(w.queueId.in).toEqual(["queue-1"]);
      expect(w.companyId).toBe("tenant-B");
    }
  });

  it("zera as métricas quando não há dados no período (período vazio)", async () => {
    const { client } = makeEmptyReportsClient();
    const sessionUserClient = makeSessionUserClient([
      { permissions: ["report.view"], scopes: [{ level: "TENANT", refId: null }] },
    ]);

    const res = await loadReport("30d", {
      reports: client,
      sessionUserClient,
      getSession: sessionFor("u1", "tenant-A", "ADMIN"),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.metrics.totalTickets).toBe(0);
    expect(res.metrics.firstResponseMinutes).toBe(0);
    expect(res.metrics.slaViolationRate).toBe(0);
    // Todos os canais presentes e zerados.
    expect(Object.values(res.metrics.throughputByChannel).every((n) => n === 0)).toBe(true);
    // Todos os status presentes e zerados.
    expect(Object.values(res.metrics.countByStatus).every((n) => n === 0)).toBe(true);
  });

  it("devolve estado de erro preservando o período quando o cálculo falha", async () => {
    const { client } = makeEmptyReportsClient();
    // Faz o count estourar para simular falha de consulta (Req. 15.7).
    (client.ticket.count as any) = vi.fn(async () => {
      throw new Error("db down");
    });
    const sessionUserClient = makeSessionUserClient([
      { permissions: ["report.view"], scopes: [{ level: "TENANT", refId: null }] },
    ]);

    const res = await loadReport("90d", {
      reports: client,
      sessionUserClient,
      getSession: sessionFor("u1", "tenant-A", "ADMIN"),
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.periodKey).toBe("90d");
    expect(res.error).toBeTruthy();
  });

  it("falha fechado quando não há sessão", async () => {
    const { client } = makeEmptyReportsClient();
    const sessionUserClient = makeSessionUserClient([]);
    const res = await loadReport("30d", {
      reports: client,
      sessionUserClient,
      getSession: async () => null,
    });
    expect(res.ok).toBe(false);
  });
});
