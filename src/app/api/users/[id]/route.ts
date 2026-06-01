import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Role } from "@prisma/client";

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  role: z.nativeEnum(Role).optional(),
});

const resetSchema = z.object({
  password: z.string().min(6),
});

async function checkAdmin(companyId: string) {
  const session = await auth();
  if (!session || !["ADMIN", "SUPERADMIN"].includes(session.user.role)) return null;
  if (session.user.companyId !== companyId && session.user.role !== "SUPERADMIN") return null;
  return session;
}

// GET — buscar usuário
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || !["ADMIN", "SUPERADMIN"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const user = await prisma.user.findFirst({
    where: { id, companyId: session.user.companyId },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(user);
}

// PATCH — editar dados
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || !["ADMIN", "SUPERADMIN"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;

  // Impedir que admin altere outro admin/superadmin de mesma empresa (exceto superadmin)
  const target = await prisma.user.findFirst({ where: { id, companyId: session.user.companyId } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (target.role === "SUPERADMIN" && session.user.role !== "SUPERADMIN") {
    return NextResponse.json({ error: "Sem permissão para alterar este usuário" }, { status: 403 });
  }

  const body = await req.json();

  // Reset de senha
  if (body.password !== undefined) {
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const hash = await bcrypt.hash(parsed.data.password, 12);
    await prisma.user.update({ where: { id }, data: { password: hash } });
    return NextResponse.json({ message: "Senha redefinida com sucesso" });
  }

  // Edição de dados
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // Verificar email duplicado
  if (parsed.data.email) {
    const existing = await prisma.user.findFirst({
      where: { email: parsed.data.email, id: { not: id } },
    });
    if (existing) return NextResponse.json({ error: "Email já em uso" }, { status: 409 });
  }

  const user = await prisma.user.update({
    where: { id },
    data: parsed.data,
    select: { id: true, name: true, email: true, role: true },
  });
  return NextResponse.json(user);
}

// DELETE — remover usuário
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || !["ADMIN", "SUPERADMIN"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;

  // Não pode deletar a si mesmo
  if (id === session.user.id) {
    return NextResponse.json({ error: "Você não pode excluir sua própria conta" }, { status: 400 });
  }

  const target = await prisma.user.findFirst({ where: { id, companyId: session.user.companyId } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (target.role === "SUPERADMIN" && session.user.role !== "SUPERADMIN") {
    return NextResponse.json({ error: "Sem permissão para excluir este usuário" }, { status: 403 });
  }

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ message: "Usuário excluído com sucesso" });
}
