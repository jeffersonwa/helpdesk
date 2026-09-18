// Property 8: Unicidade do número de ticket — Validates: Requisitos 4.5 (tarefa 9.2).
//
// Simula criações CONCORRENTES no mesmo tenant e verifica que todos os
// Ticket.number são DISTINTOS e CONTÍGUOS (o conjunto === {1..N}).
//
// Este teste hits o banco de desenvolvimento REAL através do túnel SSH
// (DATABASE_URL em localhost:55432), então é guardado para rodar apenas quando
// DATABASE_URL está definido — mesmo padrão de describe.skip usado em
// src/lib/db/__tests__/schema.integration.test.ts. Cria uma Company + fixtures
// mínimas descartáveis, dispara N transações concorrentes (cada uma reservando
// um número via nextTicketNumber e criando um Ticket) e limpa tudo no afterAll.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { nextTicketNumber } from "@/lib/tickets/sequence";

const DATABASE_URL = process.env.DATABASE_URL;

// Só roda contra um banco real; pula de forma limpa onde não houver DB.
const describeIf = DATABASE_URL ? describe : describe.skip;

// N modesto para respeitar os round trips do túnel SSH.
const N = 20;

// Pool grande o suficiente para as N transações interativas concorrentes:
// cada `$transaction` segura uma conexão até concluir. Sem folga no pool, as
// transações concorrentes competem e estouram o tempo de espera do pool.
const POOL_MAX = N + 5;

const prisma = DATABASE_URL
  ? new PrismaClient({
      adapter: new PrismaPg({
        connectionString: DATABASE_URL,
        max: POOL_MAX,
      }),
    })
  : (null as unknown as PrismaClient);

// Sufixo único para que execuções paralelas/repetidas nunca colidam em slug etc.
const RUN = `seq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Timeout generoso: cada statement é um round-trip pelo túnel SSH.
const DB_TIMEOUT_MS = 60_000;

const created: { companyId?: string; userId?: string } = {};

describeIf("Property 8: Unicidade do número de ticket (Req. 4.5)", () => {
  afterAll(async () => {
    if (!DATABASE_URL) return;
    const companyId = created.companyId;
    if (companyId) {
      // Ordem segura de FKs, escopo do tenant descartável.
      await prisma.ticket.deleteMany({ where: { companyId } });
      await prisma.ticketSequence.deleteMany({ where: { companyId } });
      if (created.userId) {
        await prisma.user.deleteMany({ where: { id: created.userId } });
      }
      await prisma.company.deleteMany({ where: { id: companyId } });
    }
    await prisma.$disconnect();
  }, DB_TIMEOUT_MS);

  it(
    "criações concorrentes no mesmo tenant produzem números distintos e contíguos",
    async () => {
      // Fixtures mínimas: tenant + usuário criador (Ticket exige createdById).
      const company = await prisma.company.create({
        data: { name: `Co ${RUN}`, slug: `co-${RUN}` },
      });
      created.companyId = company.id;

      const user = await prisma.user.create({
        data: {
          name: "Creator",
          email: `creator-${RUN}@example.test`,
          password: "x",
          role: "AGENT",
          companyId: company.id,
        },
      });
      created.userId = user.id;

      // Dispara N transações CONCORRENTES. Cada uma reserva um número via
      // nextTicketNumber e cria um Ticket com esse número, na MESMA transação.
      const numbers = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          prisma.$transaction(
            async (tx) => {
              const number = await nextTicketNumber(tx, company.id);
              await tx.ticket.create({
                data: {
                  number,
                  companyId: company.id,
                  title: `Concurrent #${i}`,
                  description: "property test",
                  createdById: user.id,
                },
              });
              return number;
            },
            // Tempos generosos: sob concorrência real via túnel SSH, esperar por
            // conexão do pool + lock de linha da sequência pode passar do padrão.
            { maxWait: 30_000, timeout: 30_000 },
          ),
        ),
      );

      // Distintos: nenhum número repetido entre as N criações concorrentes.
      const unique = new Set(numbers);
      expect(unique.size).toBe(N);

      // Contíguos: o conjunto é exatamente {1, 2, ..., N}.
      const expected = new Set(Array.from({ length: N }, (_, i) => i + 1));
      expect(unique).toEqual(expected);

      // Sanidade: o banco reflete os mesmos N números distintos para o tenant.
      const persisted = await prisma.ticket.findMany({
        where: { companyId: company.id },
        select: { number: true },
        orderBy: { number: "asc" },
      });
      expect(persisted.map((t) => t.number)).toEqual(
        Array.from({ length: N }, (_, i) => i + 1),
      );

      // A sequência avançou para N + 1 (próximo número livre).
      const seq = await prisma.ticketSequence.findUnique({
        where: { companyId: company.id },
        select: { next: true },
      });
      expect(seq?.next).toBe(N + 1);
    },
    DB_TIMEOUT_MS,
  );
});
