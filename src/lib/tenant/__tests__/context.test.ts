/**
 * Testes unitários dos helpers de isolamento de tenant (tarefa 8.2).
 *
 * Estes testes são PUROS: não tocam o banco e não usam o NextAuth real — a
 * função de sessão é sempre injetada (mock). Cobrem:
 *  - `companyId` do corpo da requisição é IGNORADO (só o valor do servidor conta);
 *  - sessão sem `companyId` é rejeitada com `AuthorizationError`;
 *  - `tenantWhere` retorna o filtro correto;
 *  - `assertSameTenant` usa apenas o `companyId` do servidor.
 *
 * Requisitos: 1.2, 1.3, 1.4.
 */

import { describe, expect, it, vi } from "vitest";
import {
  assertSameTenant,
  getTenantContext,
  tenantWhere,
  type SessionResolver,
  type TenantSession,
} from "@/lib/tenant/context";
import { AuthorizationError } from "@/lib/rbac/types";

/** Constrói um resolvedor de sessão mock que devolve a sessão dada. */
function mockSession(session: TenantSession | null): SessionResolver {
  return vi.fn(async () => session);
}

describe("getTenantContext", () => {
  it("resolve o companyId a partir da sessão do servidor", async () => {
    const resolve = mockSession({
      user: { id: "u1", companyId: "company-server", role: "ADMIN" },
    });

    const ctx = await getTenantContext(resolve);

    expect(ctx.companyId).toBe("company-server");
    expect(ctx.user).toEqual({
      id: "u1",
      companyId: "company-server",
      role: "ADMIN",
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("IGNORA qualquer companyId vindo do corpo da requisição (usa só o do servidor)", async () => {
    // Simula o "corpo da requisição" com um companyId de OUTRO tenant.
    const bodyCompanyId = "company-from-body-ATTACKER";
    const resolve = mockSession({
      user: { id: "u1", companyId: "company-server", role: "AGENT" },
    });

    const ctx = await getTenantContext(resolve);

    // O contexto derivado usa exclusivamente o valor do servidor.
    expect(ctx.companyId).toBe("company-server");
    expect(ctx.companyId).not.toBe(bodyCompanyId);

    // E `assertSameTenant` nega quando o recurso pertence ao companyId do corpo.
    expect(() => assertSameTenant(bodyCompanyId, ctx.companyId)).toThrow(
      AuthorizationError,
    );
  });

  it("rejeita quando a sessão não tem companyId (undefined)", async () => {
    const resolve = mockSession({ user: { id: "u1", role: "AGENT" } });
    await expect(getTenantContext(resolve)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("rejeita quando o companyId da sessão é nulo", async () => {
    const resolve = mockSession({
      user: { id: "u1", companyId: null, role: "AGENT" },
    });
    await expect(getTenantContext(resolve)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("rejeita quando o companyId da sessão é string vazia", async () => {
    const resolve = mockSession({
      user: { id: "u1", companyId: "", role: "AGENT" },
    });
    await expect(getTenantContext(resolve)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("rejeita quando não há sessão", async () => {
    const resolve = mockSession(null);
    await expect(getTenantContext(resolve)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("rejeita quando a sessão não tem usuário", async () => {
    const resolve = mockSession({ user: null });
    await expect(getTenantContext(resolve)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("não acessa nenhuma entidade de negócio ao rejeitar (nenhum efeito além do resolvedor)", async () => {
    const resolve = mockSession({ user: { id: "u1" } });
    await expect(getTenantContext(resolve)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    // Único efeito observável é a chamada ao resolvedor de sessão.
    expect(resolve).toHaveBeenCalledOnce();
  });
});

describe("tenantWhere", () => {
  it("retorna o fragmento de filtro { companyId }", () => {
    expect(tenantWhere("company-abc")).toEqual({ companyId: "company-abc" });
  });

  it("preserva exatamente o companyId fornecido", () => {
    const where = tenantWhere("XYZ-123");
    expect(where.companyId).toBe("XYZ-123");
    expect(Object.keys(where)).toEqual(["companyId"]);
  });
});

describe("assertSameTenant", () => {
  it("não lança quando os tenants coincidem", () => {
    expect(() => assertSameTenant("c1", "c1")).not.toThrow();
  });

  it("lança AuthorizationError quando os tenants diferem", () => {
    expect(() => assertSameTenant("c1", "c2")).toThrow(AuthorizationError);
  });
});
