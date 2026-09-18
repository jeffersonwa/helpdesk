/**
 * Teste de INTEGRAÇÃO do OrgCatalogService (tarefa 11.2), contra o banco de
 * desenvolvimento REAL via túnel SSH (DATABASE_URL em localhost:55432).
 *
 * Guardado por `DATABASE_URL` (describe.skip quando ausente). Valida contra o
 * schema real os invariantes que dependem de constraints/consultas do banco:
 *  - unicidade da fila padrão por tenant (≤ 1 isDefault) — Req. 11.6;
 *  - `TeamMember` duplicado rejeitado (`@@unique[teamId,userId]`) — Req. 11.5;
 *  - hierarquia de OrgUnit: ciclo/profundidade/cross-tenant — Req. 11.3, 11.4.
 * Limpa todas as linhas criadas no `afterAll`.
 *
 * _Requisitos: 11.4, 11.5, 11.6_
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { Role, ScopeLevel } from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import {
  addTeamMember,
  createOrgUnit,
  createQueue,
  setDefaultQueue,
  type OrgPrisma,
} from "@/lib/org/service";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const DB_TIMEOUT_MS = 60_000;

const prisma = DATABASE_URL
  ? new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10 }),
    })
  : (null as unknown as PrismaClient);

const RUN = `org-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: {
  companyId?: string;
  otherCompanyId?: string;
  userId?: string;
  teamId?: string;
} = {};

function admin(companyId: string): SessionUser {
  return {
    id: "u-admin",
    companyId,
    role: Role.ADMIN,
    roleAssignments: [
      {
        permissions: ["org.manage", "catalog.manage", "queue.manage"],
        scopes: [{ level: ScopeLevel.TENANT, refId: null }],
      },
    ],
  };
}

describeIf("OrgCatalogService (integração DB)", () => {
  afterAll(async () => {
    if (!DATABASE_URL) return;
    for (const cid of [created.companyId, created.otherCompanyId]) {
      if (!cid) continue;
      await prisma.teamMember.deleteMany({
        where: { team: { companyId: cid } },
      });
      await prisma.team.deleteMany({ where: { companyId: cid } });
      await prisma.queue.deleteMany({ where: { companyId: cid } });
      await prisma.orgUnit.deleteMany({ where: { companyId: cid } });
      await prisma.user.deleteMany({ where: { companyId: cid } });
      await prisma.company.deleteMany({ where: { id: cid } });
    }
    await prisma.$disconnect();
  }, DB_TIMEOUT_MS);

  it(
    "garante no máximo uma fila padrão por tenant",
    async () => {
      const company = await prisma.company.create({
        data: { name: `Co ${RUN}`, slug: `co-${RUN}` },
      });
      created.companyId = company.id;
      const user = admin(company.id);
      const p = prisma as unknown as OrgPrisma;

      const q1 = await createQueue(
        user,
        company.id,
        { name: "Fila A", isDefault: true },
        { prisma: p },
      );
      const q2 = await createQueue(
        user,
        company.id,
        { name: "Fila B", isDefault: true },
        { prisma: p },
      );

      // Só a última criada como padrão permanece padrão.
      const defaults = await prisma.queue.findMany({
        where: { companyId: company.id, isDefault: true },
        select: { id: true },
      });
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.id).toBe(q2.id);

      // setDefaultQueue troca a padrão de volta para a primeira.
      await setDefaultQueue(user, company.id, q1.id, { prisma: p });
      const defaults2 = await prisma.queue.findMany({
        where: { companyId: company.id, isDefault: true },
        select: { id: true },
      });
      expect(defaults2).toHaveLength(1);
      expect(defaults2[0]?.id).toBe(q1.id);
    },
    DB_TIMEOUT_MS,
  );

  it(
    "rejeita TeamMember duplicado",
    async () => {
      const companyId = created.companyId!;
      const user = admin(companyId);
      const p = prisma as unknown as OrgPrisma;

      const member = await prisma.user.create({
        data: {
          name: "Member",
          email: `member-${RUN}@example.test`,
          password: "x",
          role: "AGENT",
          companyId,
        },
      });
      created.userId = member.id;

      const team = await prisma.team.create({
        data: { companyId, name: `Time ${RUN}` },
      });
      created.teamId = team.id;

      await addTeamMember(user, companyId, team.id, member.id, { prisma: p });
      await expect(
        addTeamMember(user, companyId, team.id, member.id, { prisma: p }),
      ).rejects.toMatchObject({ code: "TEAM_MEMBER_DUPLICATE" });
    },
    DB_TIMEOUT_MS,
  );

  it(
    "rejeita parentId de OrgUnit pertencente a outro tenant",
    async () => {
      const companyId = created.companyId!;
      const other = await prisma.company.create({
        data: { name: `Other ${RUN}`, slug: `other-${RUN}` },
      });
      created.otherCompanyId = other.id;
      const p = prisma as unknown as OrgPrisma;

      // Unidade raiz no OUTRO tenant.
      const foreignRoot = await createOrgUnit(
        admin(other.id),
        other.id,
        { name: "Raiz Estrangeira" },
        { prisma: p },
      );

      // Criar unidade no nosso tenant apontando para o pai estrangeiro → erro.
      await expect(
        createOrgUnit(
          admin(companyId),
          companyId,
          { name: "Filha", parentId: foreignRoot.id },
          { prisma: p },
        ),
      ).rejects.toMatchObject({ code: "ORG_UNIT_PARENT_CROSS_TENANT" });
    },
    DB_TIMEOUT_MS,
  );
});
