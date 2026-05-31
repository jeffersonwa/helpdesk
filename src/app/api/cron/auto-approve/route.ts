import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";

// Protege o endpoint para ser chamado apenas pela Vercel Cron
function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deadline = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 horas atrás

  // Buscar tickets em PENDING_APPROVAL há mais de 48h sem resposta
  const expiredTickets = await prisma.ticket.findMany({
    where: {
      status: "PENDING_APPROVAL",
      pendingApprovalSince: { lte: deadline },
    },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
    },
  });

  if (expiredTickets.length === 0) {
    return NextResponse.json({ message: "Nenhum ticket para aprovar", count: 0 });
  }

  const results = await Promise.allSettled(
    expiredTickets.map(async (ticket) => {
      // Auto-aprovar → CLOSED
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          status: "CLOSED",
          resolvedAt: new Date(),
          pendingApprovalSince: null,
        },
      });

      const ticketUrl = `${process.env.NEXTAUTH_URL}/tickets/${ticket.id}`;

      // Notificar criador
      await sendEmail({
        to: ticket.createdBy.email,
        subject: `[Chamado #${ticket.id.slice(-6)}] Aprovado automaticamente`,
        html: `
          <p>Olá ${ticket.createdBy.name},</p>
          <p>O chamado <strong>"${ticket.title}"</strong> foi <strong>aprovado automaticamente</strong> pois não recebemos sua resposta em 48 horas.</p>
          <p>O chamado foi fechado. Caso ainda precise de suporte, abra um novo chamado.</p>
          <p><a href="${ticketUrl}" style="color:#2563eb">Ver chamado</a></p>
        `,
      });

      // Notificar agente (se houver)
      if (ticket.assignedTo?.email) {
        await sendEmail({
          to: ticket.assignedTo.email,
          subject: `[Chamado #${ticket.id.slice(-6)}] Fechado por aprovação automática`,
          html: `
            <p>Olá ${ticket.assignedTo.name},</p>
            <p>O chamado <strong>"${ticket.title}"</strong> foi <strong>fechado automaticamente</strong> após 48 horas sem resposta do cliente.</p>
            <p><a href="${ticketUrl}">Ver chamado</a></p>
          `,
        });
      }

      return ticket.id;
    })
  );

  const approved = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  console.log(`[cron/auto-approve] Aprovados: ${approved}, Falhas: ${failed}`);

  return NextResponse.json({ approved, failed, total: expiredTickets.length });
}
