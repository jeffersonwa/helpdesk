/**
 * Property 6: Isolamento de tenant (Requisitos 1.5, 2.8).
 *
 * ∀ user, resource — se `user.companyId !== resource.companyId`, então
 * `Authorization.can` retorna `false`, EXCETO operações de plataforma de
 * SUPERADMIN explicitamente marcadas (o único bypass documentado).
 *
 * Fonte: `.kiro/specs/helpdesk-omnichannel/design.md` (Correctness Property 6).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { Role, ScopeLevel } from "@/lib/domain/enums";
import type {
  ResourceRef,
  RoleAssignment,
  SessionUser,
} from "@/lib/domain/types";
import { Authorization } from "@/lib/rbac/authorization";
import { PERMISSIONS, RESOURCE_TYPES } from "@/lib/rbac/permissions";
import { PLATFORM_OPERATIONS } from "@/lib/rbac/types";

const permissionArb: fc.Arbitrary<string> = fc.constantFrom(...PERMISSIONS);
const resourceTypeArb: fc.Arbitrary<string> = fc.constantFrom(...RESOURCE_TYPES);
const scopeLevelArb: fc.Arbitrary<ScopeLevel> = fc.constantFrom(
  ...Object.values(ScopeLevel),
);
const roleArb: fc.Arbitrary<Role> = fc.constantFrom(...Object.values(Role));

const scopeArb = fc.record({
  level: scopeLevelArb,
  refId: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
});

const assignmentArb: fc.Arbitrary<RoleAssignment> = fc.record({
  permissions: fc.array(permissionArb, { minLength: 0, maxLength: PERMISSIONS.length }),
  scopes: fc.array(scopeArb, { minLength: 0, maxLength: 6 }),
});

/** Referência de recurso com campos de escopo variados. */
const resourceArb = (companyId: string): fc.Arbitrary<ResourceRef> =>
  fc.record(
    {
      companyId: fc.constant(companyId),
      type: resourceTypeArb,
      id: fc.string({ minLength: 1, maxLength: 12 }),
      unitId: fc.string({ minLength: 1, maxLength: 12 }),
      departmentId: fc.string({ minLength: 1, maxLength: 12 }),
      teamId: fc.string({ minLength: 1, maxLength: 12 }),
      queueId: fc.string({ minLength: 1, maxLength: 12 }),
      categoryId: fc.string({ minLength: 1, maxLength: 12 }),
    },
    // Cada campo opcional pode ou não estar presente.
    { requiredKeys: ["companyId", "type"] },
  );

describe("Property 6: Isolamento de tenant (Req. 1.5, 2.8)", () => {
  it("companyId divergente + ação NÃO-plataforma => can() sempre false", () => {
    // Ações que não são operações de plataforma.
    const nonPlatformActionArb = permissionArb.filter(
      (a) => !PLATFORM_OPERATIONS.has(a),
    );

    fc.assert(
      fc.property(
        // dois companyIds garantidamente diferentes
        fc.string({ minLength: 1, maxLength: 8 }),
        roleArb,
        fc.array(assignmentArb, { minLength: 0, maxLength: 4 }),
        nonPlatformActionArb,
        resourceArb("__RESOURCE_TENANT__"),
        (userCompany, role, roleAssignments, action, resourceBase) => {
          // Garante tenant divergente: recurso em tenant distinto do usuário.
          const resource: ResourceRef = {
            ...resourceBase,
            companyId: `${userCompany}#OTHER`,
          };
          fc.pre(resource.companyId !== userCompany);

          const user: SessionUser = {
            id: "u1",
            companyId: userCompany,
            role,
            roleAssignments,
          };

          return Authorization.can(user, action, resource) === false;
        },
      ),
    );
  });

  it("companyId divergente + SUPERADMIN + operação de plataforma => negado, EXCETO SUPERADMIN", () => {
    // Non-SUPERADMIN com operação de plataforma cross-tenant é sempre negado.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }),
        roleArb.filter((r) => r !== Role.SUPERADMIN),
        fc.constantFrom(...PLATFORM_OPERATIONS),
        resourceTypeArb,
        (userCompany, role, action, type) => {
          const user: SessionUser = {
            id: "u1",
            companyId: userCompany,
            role,
            roleAssignments: [
              { permissions: [...PERMISSIONS], scopes: [{ level: ScopeLevel.TENANT, refId: null }] },
            ],
          };
          const resource: ResourceRef = { companyId: `${userCompany}#OTHER`, type };
          return Authorization.can(user, action, resource) === false;
        },
      ),
    );
  });

  it("exceção documentada: SUPERADMIN em operação de plataforma é permitido cross-tenant", () => {
    for (const action of PLATFORM_OPERATIONS) {
      const superadmin: SessionUser = {
        id: "root",
        companyId: "platform-tenant",
        role: Role.SUPERADMIN,
        // Mesmo SEM atribuições, o bypass de plataforma vale para ações marcadas.
        roleAssignments: [],
      };
      const crossTenantResource: ResourceRef = {
        companyId: "some-other-tenant",
        // channel.configure -> "channel"; rbac.manage -> "role"
        type: action === "channel.configure" ? "channel" : "role",
      };
      expect(Authorization.can(superadmin, action, crossTenantResource)).toBe(
        true,
      );
    }
  });
});
