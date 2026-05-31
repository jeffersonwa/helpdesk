import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calcSlaDeadline } from "@/lib/sla";
import { z } from "zod";
import { Priority, TicketStatus } from "@prisma/client";

const createSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  priority: z.nativeEnum(Priority).default("MEDIUM"),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") as TicketStatus | null;
  const priority = searchParams.get("priority") as Priority | null;

  const where: any = { companyId: session.user.companyId };
  if (session.user.role === "CLIENT") where.createdById = session.user.id;
  if (status) where.status = status;
  if (priority) where.priority = priority;

  const tickets = await prisma.ticket.findMany({
    where,
    include: {
      createdBy: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      _count: { select: { comments: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(tickets);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const slaDeadline = await calcSlaDeadline(session.user.companyId, parsed.data.priority);

  const ticket = await prisma.ticket.create({
    data: {
      ...parsed.data,
      companyId: session.user.companyId,
      createdById: session.user.id,
      slaDeadline,
    },
  });

  return NextResponse.json(ticket, { status: 201 });
}
