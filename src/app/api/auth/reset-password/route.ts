import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(6),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });

  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { token: parsed.data.token },
    include: { user: true },
  });

  if (!resetToken) return NextResponse.json({ error: "Link inválido ou expirado" }, { status: 400 });
  if (resetToken.usedAt) return NextResponse.json({ error: "Este link já foi utilizado" }, { status: 400 });
  if (resetToken.expiresAt < new Date()) return NextResponse.json({ error: "Link expirado. Solicite um novo." }, { status: 400 });

  const hash = await bcrypt.hash(parsed.data.password, 12);

  await prisma.$transaction([
    prisma.user.update({ where: { id: resetToken.userId }, data: { password: hash } }),
    prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
  ]);

  return NextResponse.json({ message: "Senha redefinida com sucesso! Você já pode fazer login." });
}

// Verificar validade do token (GET)
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ valid: false, error: "Token não informado" });

  const resetToken = await prisma.passwordResetToken.findUnique({ where: { token } });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    return NextResponse.json({ valid: false, error: "Link inválido ou expirado" });
  }

  return NextResponse.json({ valid: true });
}
