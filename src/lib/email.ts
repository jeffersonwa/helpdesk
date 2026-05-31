import { Resend } from "resend";

export const FROM_ADDRESS = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

// Inicialização lazy — evita erro no build quando RESEND_API_KEY não está definida
let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY ?? "placeholder");
  }
  return _resend;
}

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[email] RESEND_API_KEY não configurada — email não enviado");
    return;
  }
  try {
    return await getResend().emails.send({ from: FROM_ADDRESS, to, subject, html });
  } catch (err) {
    console.error("[email] Falha ao enviar email:", err);
  }
}
