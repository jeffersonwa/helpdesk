import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session || !["ADMIN", "SUPERADMIN", "AGENT"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const companyId = session.user.companyId;
  const now = new Date();

  const [total, byStatus, byPriority, slaBreached] = await Promise.all([
    prisma.ticket.count({ where: { companyId } }),

    prisma.ticket.groupBy({
      by: ["status"],
      where: { companyId },
      _count: { status: true },
    }),

    prisma.ticket.groupBy({
      by: ["priority"],
      where: { companyId },
      _count: { priority: true },
    }),

    prisma.ticket.count({
      where: { companyId, slaDeadline: { lt: now }, status: { notIn: ["RESOLVED", "CLOSED"] } },
    }),

  ]);

  return NextResponse.json({ total, byStatus, byPriority, slaBreached });
}
