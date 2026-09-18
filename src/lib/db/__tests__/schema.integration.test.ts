// Prisma schema integration test for the omnichannel data model (task 7.4).
//
// This test hits the REAL dev database through the SSH tunnel, so it is guarded
// to run only when DATABASE_URL is set. It creates a Company and one entity from
// each major new group, asserts the key @@unique constraints actually reject
// duplicates, and cleans everything up in afterAll.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

// Only run against a real database; skip cleanly in environments without it.
const describeIf = DATABASE_URL ? describe : describe.skip;

const prisma = DATABASE_URL
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) })
  : (null as unknown as PrismaClient);

// Unique suffix so parallel/repeated runs never collide on Company.slug etc.
const RUN = `it-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Track created top-level ids for teardown.
const created: {
  companyId?: string;
  userId?: string;
} = {};

// Generous timeout: every statement is a round-trip through the SSH tunnel.
const DB_TIMEOUT_MS = 60_000;

describeIf("omnichannel schema integration", () => {
  afterAll(async () => {
    if (!DATABASE_URL) return;
    // Delete in FK-safe order, scoped to the company we created.
    const companyId = created.companyId;
    if (companyId) {
      await prisma.message.deleteMany({ where: { companyId } });
      await prisma.conversation.deleteMany({ where: { companyId } });
      await prisma.channelAccount.deleteMany({ where: { companyId } });
      await prisma.ticketEvent.deleteMany({ where: { companyId } });
      await prisma.approval.deleteMany({ where: { companyId } });
      await prisma.escalationLog.deleteMany({ where: { companyId } });
      await prisma.ticket.deleteMany({ where: { companyId } });
      await prisma.ticketSequence.deleteMany({ where: { companyId } });
      await prisma.categoryItem.deleteMany({
        where: { subcategory: { category: { companyId } } },
      });
      await prisma.subcategory.deleteMany({ where: { category: { companyId } } });
      await prisma.category.deleteMany({ where: { companyId } });
      await prisma.catalogService.deleteMany({ where: { companyId } });
      await prisma.queue.deleteMany({ where: { companyId } });
      await prisma.orgUnit.deleteMany({ where: { companyId } });
      await prisma.outboxEvent.deleteMany({ where: { companyId } });
      if (created.userId) await prisma.user.deleteMany({ where: { id: created.userId } });
      await prisma.company.deleteMany({ where: { id: companyId } });
    }
    await prisma.$disconnect();
  }, DB_TIMEOUT_MS);

  it("persists a Company and one entity from each major new group", async () => {
    // Tenant root
    const company = await prisma.company.create({
      data: { name: `Co ${RUN}`, slug: `co-${RUN}` },
    });
    created.companyId = company.id;
    expect(company.id).toBeTruthy();

    // A user (needed as ticket creator)
    const user = await prisma.user.create({
      data: {
        name: "Agent",
        email: `agent-${RUN}@example.test`,
        password: "x",
        role: "AGENT",
        companyId: company.id,
      },
    });
    created.userId = user.id;

    // Organization group
    const orgUnit = await prisma.orgUnit.create({
      data: { companyId: company.id, name: "HQ" },
    });
    expect(orgUnit.companyId).toBe(company.id);

    // Queue group
    const queue = await prisma.queue.create({
      data: { companyId: company.id, name: "Default", isDefault: true },
    });

    // Catalog chain: CatalogService -> Category -> Subcategory -> CategoryItem
    const service = await prisma.catalogService.create({
      data: { companyId: company.id, name: "IT" },
    });
    const category = await prisma.category.create({
      data: { companyId: company.id, name: "Hardware", serviceId: service.id },
    });
    const subcategory = await prisma.subcategory.create({
      data: { categoryId: category.id, name: "Laptop" },
    });
    const item = await prisma.categoryItem.create({
      data: { subcategoryId: subcategory.id, name: "Battery" },
    });
    expect(item.subcategoryId).toBe(subcategory.id);

    // Channel + Conversation + Message
    const account = await prisma.channelAccount.create({
      data: {
        companyId: company.id,
        type: "WHATSAPP",
        provider: "WHATSAPP_MOCK",
        label: "Mock WA",
        secretRef: "env:WA_SECRET_REF", // reference only, never a secret value
      },
    });
    const conversation = await prisma.conversation.create({
      data: {
        companyId: company.id,
        channelAccountId: account.id,
        contactExternalId: "+5511999999999",
        state: "OPEN",
      },
    });
    const extId = `ext-${RUN}`;
    const message = await prisma.message.create({
      data: {
        companyId: company.id,
        conversationId: conversation.id,
        direction: "INBOUND",
        type: "TEXT",
        body: "hello",
        externalId: extId,
      },
    });
    expect(message.conversationId).toBe(conversation.id);

    // @@unique([companyId, externalId]) on Message must reject a duplicate.
    await expect(
      prisma.message.create({
        data: {
          companyId: company.id,
          conversationId: conversation.id,
          direction: "INBOUND",
          type: "TEXT",
          body: "dup",
          externalId: extId,
        },
      }),
    ).rejects.toThrow();

    // Ticket with a number; then TicketEvent, Approval, EscalationLog.
    await prisma.ticketSequence.create({ data: { companyId: company.id, next: 2 } });
    const ticket = await prisma.ticket.create({
      data: {
        number: 1,
        companyId: company.id,
        title: "First ticket",
        description: "desc",
        createdById: user.id,
        queueId: queue.id,
        conversationId: conversation.id,
        impact: "HIGH",
        urgency: "HIGH",
        priority: "CRITICAL",
        origin: "WHATSAPP",
      },
    });
    expect(ticket.number).toBe(1);

    await prisma.ticketEvent.create({
      data: { companyId: company.id, ticketId: ticket.id, type: "created" },
    });
    await prisma.approval.create({
      data: { companyId: company.id, ticketId: ticket.id, approverId: user.id },
    });
    await prisma.escalationLog.create({
      data: { companyId: company.id, ticketId: ticket.id, trigger: "MANUAL" },
    });

    // @@unique([companyId, number]) on Ticket must reject a duplicate number.
    await expect(
      prisma.ticket.create({
        data: {
          number: 1,
          companyId: company.id,
          title: "Dup number",
          description: "desc",
          createdById: user.id,
        },
      }),
    ).rejects.toThrow();

    // OutboxEvent
    const outbox = await prisma.outboxEvent.create({
      data: {
        companyId: company.id,
        type: "webhook.dispatch",
        payload: { hello: "world" },
      },
    });
    expect(outbox.state).toBe("PENDING");
    expect(outbox.attempts).toBe(0);
  }, DB_TIMEOUT_MS);
});
