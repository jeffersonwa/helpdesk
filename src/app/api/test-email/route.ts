import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sendEmail } from "@/lib/email";

// Endpoint temporário para testar configuração de email
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session || !["ADMIN", "SUPERADMIN"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const resendConfigured = !!process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== "placeholder";
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const appUrl = process.env.NEXTAUTH_URL ?? "não configurado";

  if (!resendConfigured) {
    return NextResponse.json({
      status: "not_configured",
      message: "RESEND_API_KEY não está configurada na Vercel",
      from: fromEmail,
      appUrl,
      instrucoes: [
        "1. Acesse https://resend.com e crie uma conta",
        "2. Crie uma API Key em https://resend.com/api-keys",
        "3. Execute: npx vercel env add RESEND_API_KEY production",
        "4. Execute: npx vercel env add RESEND_FROM_EMAIL production (ex: helpdesk@seudominio.com)",
        "5. Redeploy: npx vercel --prod"
      ]
    });
  }

  const { to } = await req.json().catch(() => ({ to: session.user.email }));

  try {
    await sendEmail({
      to: to ?? session.user.email,
      subject: "✅ Teste de email — Helpdesk funcionando",
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#2563eb">✅ Email configurado com sucesso!</h2>
          <p>Olá <strong>${session.user.name}</strong>,</p>
          <p>Este é um email de teste do sistema de helpdesk.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="color:#6b7280;font-size:12px">
            Enviado de: ${fromEmail}<br>
            App URL: ${appUrl}<br>
            Horário: ${new Date().toISOString()}
          </p>
        </div>
      `,
    });

    return NextResponse.json({
      status: "sent",
      message: `Email de teste enviado para ${to ?? session.user.email}`,
      from: fromEmail,
    });
  } catch (err: any) {
    return NextResponse.json({
      status: "error",
      message: err.message,
      from: fromEmail,
    }, { status: 500 });
  }
}

export async function GET() {
  const resendConfigured = !!process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== "placeholder";
  return NextResponse.json({
    resend_configured: resendConfigured,
    from_email: process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev (padrão)",
    app_url: process.env.NEXTAUTH_URL ?? "não configurado",
  });
}
