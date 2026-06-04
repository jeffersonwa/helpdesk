import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { Resend } from "resend";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";

  // Em desenvolvimento sem secret configurado, aceitar sem verificar
  if (secret) {
    const svixId = req.headers.get("svix-id") ?? "";
    const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
    const svixSignature = req.headers.get("svix-signature") ?? "";

    if (!svixId || !svixTimestamp || !svixSignature) {
      return NextResponse.json({ error: "Missing Svix headers" }, { status: 401 });
    }

    try {
      const resend = new Resend(process.env.RESEND_API_KEY ?? "placeholder");
      resend.webhooks.verify({
        payload: rawBody,
        headers: {
          id: svixId,
          timestamp: svixTimestamp,
          signature: svixSignature,
        },
        webhookSecret: secret,
      });
    } catch (err: any) {
      console.error("[webhook] Signature verification failed:", err.message);
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let payload: {
    from?: string;
    subject?: string;
    text?: string;
    html?: string;
    to?: string[];
  };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload.from) {
    return NextResponse.json({ error: "Missing from field" }, { status: 400 });
  }

  // Extrair email do formato "Nome <email@domain.com>" ou "email@domain.com"
  const emailMatch = payload.from.match(/<([^>]+)>/) ?? payload.from.match(/^([^\s]+)$/);
  const senderEmail = (emailMatch?.[1] ?? payload.from).toLowerCase().trim();

  // Validar se o remetente tem cadastro
  const user = await prisma.user.findUnique({
    where: { email: senderEmail },
    include: { company: true },
  });

  if (!user) {
    await sendEmail({
      to: senderEmail,
      subject: `Re: ${payload.subject ?? "(sem assunto)"} — Remetente não cadastrado`,
      html: `
        <p>Olá,</p>
        <p>Seu endereço de email (<strong>${senderEmail}</strong>) não está cadastrado no sistema de helpdesk.</p>
        <p>Para abrir chamados por email, solicite ao administrador que crie uma conta para você.</p>
        <p>Acesse o sistema: <a href="${process.env.NEXTAUTH_URL}">${process.env.NEXTAUTH_URL}</a></p>
      `,
    });
    return NextResponse.json({ message: "Sender not registered" });
  }

  // Limpar corpo do email (remover assinaturas e replies anteriores)
  const rawText = payload.text ?? payload.html?.replace(/<[^>]+>/g, "") ?? "(sem conteúdo)";
  const description = rawText
    .split(/\n--\s*\n|\nOn .+wrote:|\n_{3,}|\n-{3,}/)[0]
    .trim()
    .slice(0, 5000);

  const title = (payload.subject ?? "(sem assunto)")
    .replace(/^(Re:|Fwd:|Encam\.:)\s*/i, "")
    .trim()
    .slice(0, 255) || "(sem assunto)";

  const ticket = await prisma.ticket.create({
    data: {
      title,
      description,
      status: "OPEN",
      priority: "MEDIUM",
      companyId: user.companyId,
      createdById: user.id,
    },
  });

  // Confirmar criação ao remetente
  const ticketUrl = `${process.env.NEXTAUTH_URL}/tickets/${ticket.id}`;
  await sendEmail({
    to: user.email,
    subject: `[Chamado #${ticket.id.slice(-6)}] Recebido: ${title}`,
    html: `
      <p>Olá ${user.name},</p>
      <p>Seu chamado foi criado com sucesso! 🎉</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Número:</td><td><strong>#${ticket.id.slice(-6)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Título:</td><td>${title}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Status:</td><td>Aberto</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Prioridade:</td><td>Média</td></tr>
      </table>
      <p>Acompanhe o status do seu chamado em:</p>
      <p><a href="${ticketUrl}" style="color:#2563eb">${ticketUrl}</a></p>
    `,
  });

  return NextResponse.json({ ticketId: ticket.id, title });
}
