/**
 * Property 7: Cobertura de escopo (Requisitos 2.4, 2.5).
 *
 * - Um escopo `TENANT` cobre QUALQUER recurso do mesmo tenant cuja ação
 *   esteja nas permissões → `can` === true.
 * - Um escopo mais restrito (ex.: `QUEUE:refId`) NUNCA concede acesso fora do
 *   `refId`: `can` === true apenas quando o `queueId` do recurso casa com o
 *   `refId`; caso contrário `can` === false.
 *
 * Fonte: `.kiro/specs/helpdesk-omnichannel/design.md` (Correctness Property 7).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { Role, ScopeLevel } from "@/lib/domain/enums";
import type { ResourceRef, SessionUser } from "@/lib/domain/types";
import { Authorization } from "@/lib/rbac/authorization";
import { PERMISSIONS, RESOURCE_TYPES } from "@/lib/rbac/permissions";

const TENANT = "tenant-A";
const permissionArb: fc.Arbitrary<string> = fc.constantFrom(...PERMISSIONS);
const resourceTypeArb: fc.Arbitrary<string> = fc.constantFrom(...RESOURCE_TYPES);

/** Recurso arbitrário do mesmo tenant, com campos de escopo variados. */
const sameTenantResourceArb: fc.Arbitrary<ResourceRef> = fc.record(
  {
    companyId: fc.constant(TENANT),
    type: resourceTypeArb,
    id: fc.string({ minLength: 1, maxLength: 12 }),
    unitId: fc.string({ minLength: 1, maxLength: 12 }),
    departmentId: fc.string({ minLength: 1, maxLength: 12 }),
    teamId: fc.string({ minLength: 1, maxLength: 12 }),
    queueId: fc.string({ minLength: 1, maxLength: 12 }),
    categoryId: fc.string({ minLength: 1, maxLength: 12 }),
  },
  { requiredKeys: ["companyId", "type"] },
);

describe("Property 7: Cobertura de escopo (Req. 2.4, 2.5)", () => {
  it("escopo TENANT cobre qualquer recurso do mesmo tenant com a ação concedida", () => {
    fc.assert(
      fc.property(
        permissionArb,
        sameTenantResourceArb,
        (action, resource) => {
          const user: SessionUser = {
            id: "u1",
            companyId: TENANT,
            role: Role.ADMIN,
            roleAssignments: [
              { permissions: [action], scopes: [{ level: ScopeLevel.TENANT, refId: null }] },
            ],
          };
          return Authorization.can(user, action, resource) === true;
        },
      ),
    );
  });

  it("escopo QUEUE:refId concede apenas para o queueId correspondente", () => {
    fc.assert(
      fc.property(
        permissionArb,
        fc.string({ minLength: 1, maxLength: 12 }), // refId do escopo
        fc.string({ minLength: 1, maxLength: 12 }), // queueId do recurso
        (action, scopeRefId, resourceQueueId) => {
          const user: SessionUser = {
            id: "u1",
            companyId: TENANT,
            role: Role.AGENT,
            roleAssignments: [
              { permissions: [action], scopes: [{ level: ScopeLevel.QUEUE, refId: scopeRefId }] },
            ],
          };
          const resource: ResourceRef = {
            companyId: TENANT,
            type: "ticket",
            queueId: resourceQueueId,
          };
          const expected = resourceQueueId === scopeRefId;
          return Authorization.can(user, action, resource) === expected;
        },
      ),
    );
  });

  it("escopo QUEUE:refId nega quando o recurso não carrega queueId (fail-closed)", () => {
    fc.assert(
      fc.property(permissionArb, (action) => {
        const user: SessionUser = {
          id: "u1",
          companyId: TENANT,
          role: Role.AGENT,
          roleAssignments: [
            { permissions: [action], scopes: [{ level: ScopeLevel.QUEUE, refId: "q-1" }] },
          ],
        };
        // Recurso sem queueId → escopo de fila não pode cobrir.
        const resource: ResourceRef = { companyId: TENANT, type: "ticket" };
        return Authorization.can(user, action, resource) === false;
      }),
    );
  });

  it("caso concreto: matching queueId => true; queueId diferente => false", () => {
    const user: SessionUser = {
      id: "u1",
      companyId: TENANT,
      role: Role.AGENT,
      roleAssignments: [
        { permissions: ["ticket.read"], scopes: [{ level: ScopeLevel.QUEUE, refId: "queue-42" }] },
      ],
    };
    expect(
      Authorization.can(user, "ticket.read", {
        companyId: TENANT,
        type: "ticket",
        queueId: "queue-42",
      }),
    ).toBe(true);
    expect(
      Authorization.can(user, "ticket.read", {
        companyId: TENANT,
        type: "ticket",
        queueId: "queue-99",
      }),
    ).toBe(false);
  });
});
