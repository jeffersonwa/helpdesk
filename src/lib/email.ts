import { Resend } from "resend";

export const resend = new Resend(process.env.RESEND_API_KEY!);

export const FROM_ADDRESS = process.env.RESEND_FROM_EMAIL ?? "helpdesk@resend.dev";

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {
  try {
    return await resend.emails.send({ from: FROM_ADDRESS, to, subject, html });
  } catch (err) {
    // Não deixar falha de email derrubar a operação principal
    console.error("[email] Failed to send:", err);
  }
}
