import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { z } from "zod";

const schema = z.object({
  action: z.enum(["approve", "reject"]),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ticket = await prisma.ticket.findFirst({
    where: { id, companyId: session.user.companyId },
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });

  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isAdminOrAbove = ["ADMIN", "SUPERADMIN"].includes(session.user.role);
  const isCreator = ticket.createdById === session.user.id;

  if (!isCreator && !isAdminOrAbove) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isAdminOrAbove && ticket.status !== "PENDING_APPROVAL") {
    return NextResponse.json({ error: "Ticket não está aguardando aprovação" }, { status: 409 });
  }

  const newStatus = parsed.data.action === "approve" ? "CLOSED" : "IN_PROGRESS";

  const updated = await prisma.ticket.update({
    where: { id },
    data: {
      status: newStatus,
      resolvedAt: parsed.data.action === "approve" ? new Date() : null,
    },
  });

  // Notificar agente responsável
  if (ticket.assignedTo?.email) {
    const actionLabel = parsed.data.action === "approve" ? "aprovada ✅" : "rejeitada ❌";
    await sendEmail({
      to: ticket.assignedTo.email,
      subject: `[Chamado #${ticket.id.slice(-6)}] Solução ${actionLabel}`,
      html: `
        <p>Olá ${ticket.assignedTo.name},</p>
        <p>A solução do chamado <strong>"${ticket.title}"</strong> foi <strong>${actionLabel}</strong> pelo cliente.</p>
        ${parsed.data.action === "reject"
          ? "<p>O chamado voltou ao status <strong>Em Andamento</strong>. Por favor, continue o atendimento.</p>"
          : "<p>O chamado foi <strong>fechado</strong> com sucesso.</p>"}
        <p><a href="${process.env.NEXTAUTH_URL}/tickets/${ticket.id}">Ver chamado</a></p>
      `,
    });
  }

  return NextResponse.json(updated);
}
