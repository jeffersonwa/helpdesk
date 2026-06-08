import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "SUPERADMIN") {
    return NextResponse.json({ error: "Apenas SUPERADMIN pode excluir empresas" }, { status: 403 });
  }

  const { id } = await params;

  // Não pode excluir a própria empresa
  if (id === session.user.companyId) {
    return NextResponse.json({ error: "Não é possível excluir sua própria empresa" }, { status: 400 });
  }

  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return NextResponse.json({ error: "Empresa não encontrada" }, { status: 404 });

  // Excluir em cascata (comentários → tickets → usuários → empresa)
  await prisma.$transaction([
    prisma.comment.deleteMany({ where: { ticket: { companyId: id } } }),
    prisma.ticket.deleteMany({ where: { companyId: id } }),
    prisma.slaRule.deleteMany({ where: { companyId: id } }),
    prisma.user.deleteMany({ where: { companyId: id } }),
    prisma.company.delete({ where: { id } }),
  ]);

  return NextResponse.json({ message: `Empresa "${company.name}" excluída com sucesso` });
}
