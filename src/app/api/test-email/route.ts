import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sendEmail, FROM_ADDRESS } from "@/lib/email";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session || !["ADMIN", "SUPERADMIN"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const smtpConfigured = !!(process.env.SMTP_PASS ?? process.env.RESEND_API_KEY);

  if (!smtpConfigured) {
    return NextResponse.json({
      status: "not_configured",
      message: "Credenciais SMTP não configuradas",
      instrucoes: [
        "Configure as variáveis: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM",
        "Para Resend SMTP: SMTP_HOST=smtp.resend.com, SMTP_PORT=465, SMTP_USER=resend, SMTP_PASS=<sua-api-key>",
      ],
    });
  }

  const { to } = await req.json().catch(() => ({ to: session.user.email }));

  try {
    await sendEmail({
      to: to ?? session.user.email,
      subject: "✅ Teste SMTP — Helpdesk Ni Tecnologia",
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <img src="${process.env.NEXTAUTH_URL}/logo.jpeg" alt="Ni Tecnologia" style="height:50px;margin-bottom:20px" />
          <h2 style="color:#2563eb">✅ SMTP configurado com sucesso!</h2>
          <p>Olá <strong>${session.user.name}</strong>,</p>
          <p>Este email confirma que o servidor SMTP está funcionando corretamente.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="color:#6b7280;font-size:12px">
            De: ${FROM_ADDRESS}<br>
            Servidor: ${process.env.SMTP_HOST ?? "smtp.resend.com"}:${process.env.SMTP_PORT ?? "465"}<br>
            Horário: ${new Date().toLocaleString("pt-BR")}
          </p>
        </div>
      `,
    });

    return NextResponse.json({
      status: "sent",
      message: `Email enviado para ${to ?? session.user.email}`,
      from: FROM_ADDRESS,
      smtp_host: process.env.SMTP_HOST ?? "smtp.resend.com",
    });
  } catch (err: any) {
    return NextResponse.json({ status: "error", message: err.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    smtp_host: process.env.SMTP_HOST ?? "smtp.resend.com",
    smtp_port: process.env.SMTP_PORT ?? "465",
    smtp_user: process.env.SMTP_USER ?? "resend",
    smtp_configured: !!(process.env.SMTP_PASS ?? process.env.RESEND_API_KEY),
    from_email: FROM_ADDRESS,
    app_url: process.env.NEXTAUTH_URL ?? "não configurado",
  });
}
