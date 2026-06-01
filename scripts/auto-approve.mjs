/**
 * Script de auto-aprovação — roda diretamente no banco via Prisma.
 * Usado pelo GitHub Actions para fechar tickets em PENDING_APPROVAL há +48h.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Resend } from "resend";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const FROM = process.env.RESEND_FROM_EMAIL ?? "helpdesk@resend.dev";
const APP_URL = process.env.APP_URL ?? "https://helpdesk-pi-teal.vercel.app";
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.log(`[email skip] ${to} — ${subject}`);
    return;
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (e) {
    console.error(`[email error] ${e.message}`);
  }
}

async function main() {
  const deadline = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const tickets = await prisma.ticket.findMany({
    where: {
      status: "PENDING_APPROVAL",
      pendingApprovalSince: { lte: deadline },
    },
    include: {
      createdBy: { select: { name: true, email: true } },
      assignedTo: { select: { name: true, email: true } },
    },
  });

  console.log(`Tickets expirados encontrados: ${tickets.length}`);

  if (tickets.length === 0) {
    console.log("Nenhum ticket para aprovar automaticamente.");
    return;
  }

  let aprovados = 0;
  let erros = 0;

  for (const ticket of tickets) {
    try {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          status: "CLOSED",
          resolvedAt: new Date(),
          pendingApprovalSince: null,
        },
      });

      const url = `${APP_URL}/tickets/${ticket.id}`;

      await sendEmail({
        to: ticket.createdBy.email,
        subject: `[Chamado #${ticket.id.slice(-6)}] Aprovado automaticamente`,
        html: `
          <p>Olá ${ticket.createdBy.name},</p>
          <p>O chamado <strong>"${ticket.title}"</strong> foi <strong>aprovado automaticamente</strong> pois não recebemos sua resposta em 48 horas.</p>
          <p>O chamado foi fechado. Se ainda precisar de suporte, abra um novo chamado.</p>
          <p><a href="${url}">Ver chamado</a></p>
        `,
      });

      if (ticket.assignedTo?.email) {
        await sendEmail({
          to: ticket.assignedTo.email,
          subject: `[Chamado #${ticket.id.slice(-6)}] Fechado por aprovação automática`,
          html: `
            <p>Olá ${ticket.assignedTo.name},</p>
            <p>O chamado <strong>"${ticket.title}"</strong> foi fechado automaticamente após 48h sem resposta do cliente.</p>
            <p><a href="${url}">Ver chamado</a></p>
          `,
        });
      }

      console.log(`✓ Aprovado: ${ticket.id} — "${ticket.title}"`);
      aprovados++;
    } catch (e) {
      console.error(`✗ Erro no ticket ${ticket.id}: ${e.message}`);
      erros++;
    }
  }

  console.log(`\nConcluído: ${aprovados} aprovados, ${erros} erros.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
