import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import crypto from "crypto";
import { z } from "zod";

const schema = z.object({ email: z.string().email() });

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Email inválido" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  // Sempre retorna 200 para não revelar quais emails existem
  if (!user) return NextResponse.json({ message: "Se o email existir, você receberá as instruções." });

  // Invalidar tokens anteriores
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });

  // Criar novo token (expira em 1h)
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: { token, userId: user.id, expiresAt },
  });

  const resetUrl = `${process.env.NEXTAUTH_URL}/reset-password?token=${token}`;

  await sendEmail({
    to: user.email,
    subject: "Redefinição de senha — Helpdesk",
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
        <h2 style="color:#2563eb">Redefinição de senha</h2>
        <p>Olá <strong>${user.name}</strong>,</p>
        <p>Recebemos uma solicitação para redefinir sua senha. Clique no botão abaixo:</p>
        <p style="margin:24px 0">
          <a href="${resetUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500">
            Redefinir senha
          </a>
        </p>
        <p>Este link expira em <strong>1 hora</strong>.</p>
        <p style="color:#6b7280;font-size:12px">Se você não solicitou isso, ignore este email — sua senha não será alterada.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#9ca3af;font-size:11px">Ou copie este link: ${resetUrl}</p>
      </div>
    `,
  });

  return NextResponse.json({ message: "Se o email existir, você receberá as instruções." });
}
