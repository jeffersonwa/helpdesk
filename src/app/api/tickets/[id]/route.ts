import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { z } from "zod";
import { Priority, TicketStatus } from "@prisma/client";

const updateSchema = z.object({
  status: z.nativeEnum(TicketStatus).optional(),
  priority: z.nativeEnum(Priority).optional(),
  assignedToId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const ticket = await prisma.ticket.findFirst({
    where: { id, companyId: session.user.companyId },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      assignedTo: { select: { id: true, name: true } },
      comments: {
        include: { author: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(ticket);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const isAdminOrAbove = ["ADMIN", "SUPERADMIN"].includes(session.user.role);

  // Agentes marcando RESOLVED → vai para PENDING_APPROVAL (admins passam direto)
  let effectiveStatus = parsed.data.status;
  if (effectiveStatus === "RESOLVED" && !isAdminOrAbove) {
    effectiveStatus = "PENDING_APPROVAL";
  }

  const data: Record<string, unknown> = { ...parsed.data, status: effectiveStatus };

  if (effectiveStatus === "PENDING_APPROVAL") {
    data.pendingApprovalSince = new Date();
  }
  if (effectiveStatus === "RESOLVED" || effectiveStatus === "CLOSED") {
    data.resolvedAt = new Date();
    data.pendingApprovalSince = null;
  }
  if (effectiveStatus === "IN_PROGRESS" || effectiveStatus === "OPEN") {
    data.pendingApprovalSince = null;
  }

  const ticket = await prisma.ticket.update({
    where: { id, companyId: session.user.companyId },
    data,
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });

  // Notificar criador quando entra em aprovação
  if (effectiveStatus === "PENDING_APPROVAL") {
    const approvalUrl = `${process.env.NEXTAUTH_URL}/tickets/${ticket.id}`;
    await sendEmail({
      to: ticket.createdBy.email,
      subject: `[Chamado #${ticket.id.slice(-6)}] Solução aguardando sua aprovação`,
      html: `
        <p>Olá ${ticket.createdBy.name},</p>
        <p>O chamado <strong>"${ticket.title}"</strong> foi marcado como resolvido pelo agente.</p>
        <p>Por favor, acesse o link abaixo para <strong>aprovar</strong> ou <strong>rejeitar</strong> a solução:</p>
        <p><a href="${approvalUrl}" style="color:#2563eb">${approvalUrl}</a></p>
        <br>
        <p style="color:#6b7280;font-size:12px">Se você já resolveu seu problema, clique em Aprovar. Caso contrário, clique em Rejeitar e o chamado será reaberto.</p>
      `,
    });
  }

  return NextResponse.json(ticket);
}
