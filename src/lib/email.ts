import nodemailer from "nodemailer";

export const FROM_ADDRESS = process.env.SMTP_FROM ?? process.env.RESEND_FROM_EMAIL ?? "helpdesk@nitecnologia.tec.br";

// Transportador SMTP — inicialização lazy
let _transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? "smtp.resend.com",
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: (process.env.SMTP_PORT ?? "465") === "465", // true para 465, false para 587
      auth: {
        user: process.env.SMTP_USER ?? "resend",
        pass: process.env.SMTP_PASS ?? process.env.RESEND_API_KEY ?? "",
      },
    });
  }
  return _transporter;
}

export async function sendEmail({
  to,
  subject,
  html,
  from,
}: {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
}) {
  const apiKey = process.env.SMTP_PASS ?? process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email] Credenciais SMTP não configuradas — email não enviado");
    return;
  }

  try {
    const info = await getTransporter().sendMail({
      from: from ?? FROM_ADDRESS,
      to: Array.isArray(to) ? to.join(", ") : to,
      subject,
      html,
    });
    console.log(`[email] Enviado: ${info.messageId} → ${to}`);
    return info;
  } catch (err) {
    console.error("[email] Falha ao enviar via SMTP:", err);
    throw err;
  }
}
