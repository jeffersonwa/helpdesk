/**
 * Testes unitários de FAIL-CLOSED do RBAC (Requisitos 2.9, 2.10).
 *
 * O motor de autorização deve NEGAR por padrão em qualquer situação
 * ambígua ou não reconhecida:
 *  - ação desconhecida (fora do catálogo) → negar (2.10);
 *  - tipo de recurso desconhecido (fora do registro) → negar (2.10);
 *  - usuário sem papéis atribuídos → negar (2.9);
 *  - permissão presente mas nenhum escopo cobre o recurso → negar;
 *  - permissão ausente → negar.
 *
 * Também valida `assert`: lança `AuthorizationError` com mensagem genérica
 * (não vaza informação sensível) e não expõe detalhes do recurso.
 */

import { describe, it, expect } from "vitest";

import { Role, ScopeLevel } from "@/lib/domain/enums";
import type { ResourceRef, SessionUser } from "@/lib/domain/types";
import { Authorization, AuthorizationError } from "@/lib/rbac/authorization";

const TENANT = "tenant-A";

/** Usuário com permissão ampla e escopo de tenant (base para variações). */
function tenantAdmin(permissions: string[]): SessionUser {
  return {
    id: "admin",
    companyId: TENANT,
    role: Role.ADMIN,
    roleAssignments: [
      { permissions, scopes: [{ level: ScopeLevel.TENANT, refId: null }] },
    ],
  };
}

const ticketResource: ResourceRef = { companyId: TENANT, type: "ticket" };

describe("RBAC fail-closed (Req. 2.9, 2.10)", () => {
  it("ação desconhecida (fora do catálogo) => nega", () => {
    const user = tenantAdmin(["ticket.read", "ticket.update"]);
    expect(
      Authorization.can(user, "ticket.frobnicate", ticketResource),
    ).toBe(false);
    // string vazia também é ação desconhecida
    expect(Authorization.can(user, "", ticketResource)).toBe(false);
  });

  it("tipo de recurso desconhecido (fora do registro) => nega", () => {
    const user = tenantAdmin(["ticket.read"]);
    const unknownResource: ResourceRef = { companyId: TENANT, type: "spaceship" };
    expect(Authorization.can(user, "ticket.read", unknownResource)).toBe(false);
  });

  it("usuário sem papéis atribuídos => nega", () => {
    const user: SessionUser = {
      id: "nobody",
      companyId: TENANT,
      role: Role.AGENT,
      roleAssignments: [],
    };
    expect(Authorization.can(user, "ticket.read", ticketResource)).toBe(false);
  });

  it("permissão presente mas nenhum escopo cobre o recurso => nega", () => {
    // Permissão concedida, porém escopo QUEUE:q-1 e recurso em outra fila.
    const user: SessionUser = {
      id: "agent",
      companyId: TENANT,
      role: Role.AGENT,
      roleAssignments: [
        { permissions: ["ticket.read"], scopes: [{ level: ScopeLevel.QUEUE, refId: "q-1" }] },
      ],
    };
    const resource: ResourceRef = { companyId: TENANT, type: "ticket", queueId: "q-2" };
    expect(Authorization.can(user, "ticket.read", resource)).toBe(false);
  });

  it("atribuição sem escopo algum => nega mesmo com a permissão", () => {
    const user: SessionUser = {
      id: "agent",
      companyId: TENANT,
      role: Role.AGENT,
      roleAssignments: [{ permissions: ["ticket.read"], scopes: [] }],
    };
    expect(Authorization.can(user, "ticket.read", ticketResource)).toBe(false);
  });

  it("permissão ausente (escopo cobre, mas ação não concedida) => nega", () => {
    const user = tenantAdmin(["ticket.read"]);
    expect(Authorization.can(user, "ticket.delete", ticketResource)).toBe(false);
  });

  it("não combina permissão de uma atribuição com escopo de outra", () => {
    // Atribuição A: concede ticket.read mas sem escopo.
    // Atribuição B: escopo TENANT mas sem ticket.read.
    const user: SessionUser = {
      id: "agent",
      companyId: TENANT,
      role: Role.AGENT,
      roleAssignments: [
        { permissions: ["ticket.read"], scopes: [] },
        { permissions: ["ticket.update"], scopes: [{ level: ScopeLevel.TENANT, refId: null }] },
      ],
    };
    // ticket.read não tem escopo cobrindo; ticket.update tem escopo mas é outra ação.
    expect(Authorization.can(user, "ticket.read", ticketResource)).toBe(false);
  });

  it("caso positivo de controle: permissão + escopo TENANT + mesmo tenant => permite", () => {
    const user = tenantAdmin(["ticket.read"]);
    expect(Authorization.can(user, "ticket.read", ticketResource)).toBe(true);
  });
});

describe("Authorization.assert (Req. 2.7)", () => {
  it("lança AuthorizationError quando negado", () => {
    const user = tenantAdmin(["ticket.read"]);
    expect(() =>
      Authorization.assert(user, "ticket.delete", ticketResource),
    ).toThrow(AuthorizationError);
  });

  it("mensagem genérica não vaza tenant, recurso, ação ou permissões", () => {
    const user = tenantAdmin(["ticket.read"]);
    try {
      Authorization.assert(user, "ticket.delete", {
        companyId: TENANT,
        type: "ticket",
        id: "secret-ticket-123",
        queueId: "secret-queue",
      });
      throw new Error("esperava AuthorizationError");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      const msg = (err as AuthorizationError).message;
      expect(msg).not.toContain("secret-ticket-123");
      expect(msg).not.toContain("secret-queue");
      expect(msg).not.toContain(TENANT);
      expect(msg).not.toContain("ticket.delete");
      expect((err as AuthorizationError).code).toBe("AUTHORIZATION_DENIED");
    }
  });

  it("não lança quando permitido", () => {
    const user = tenantAdmin(["ticket.read"]);
    expect(() =>
      Authorization.assert(user, "ticket.read", ticketResource),
    ).not.toThrow();
  });
});
