import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { nextTicketNumber } from "@/lib/tickets/sequence";
import crypto from "crypto";

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Buffers de tamanhos diferentes quebrariam timingSafeEqual — compara
  // contra um hash de tamanho fixo primeiro para não vazar o tamanho do secret.
  if (bufA.length !== bufB.length) {
    const hashA = crypto.createHash("sha256").update(bufA).digest();
    const hashB = crypto.createHash("sha256").update(bufB).digest();
    crypto.timingSafeEqual(hashA, hashB); // consome tempo constante, resultado descartado
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  // Sem secret configurado, o endpoint fica aberto para qualquer um criar
  // tickets em nome de usuários cadastrados — recusar em vez de permitir.
  if (!secret) {
    console.error("[webhook/email] RESEND_WEBHOOK_SECRET não configurado — recusando requisição");
    return NextResponse.json({ error: "Webhook não configurado" }, { status: 503 });
  }

  const ip = getClientIp(req);
  const ipLimit = rateLimit(`webhook-email:ip:${ip}`, 30, 5 * 60 * 1000);
  if (!ipLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Autenticação via token no header ou query param
  const token = req.headers.get("x-webhook-token")
    ?? req.nextUrl.searchParams.get("token")
    ?? "";

  if (!timingSafeEqual(token, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: any;
  try {
    const rawBody = await req.text();
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Suporte ao formato Resend inbound: { from, to, subject, text, html }
  // e formato wrapped: { type: "email.received", data: { ... } }
  const email = payload.data ?? payload;

  const from: string = email.from ?? "";
  const subject: string = email.subject ?? "(sem assunto)";
  const text: string = email.text ?? "";
  const html: string = email.html ?? "";

  if (!from) {
    return NextResponse.json({ error: "Missing from field" }, { status: 400 });
  }

  // Extrair email do formato "Nome <email@domain.com>"
  const emailMatch = from.match(/<([^>]+)>/) ?? [null, from.trim()];
  const senderEmail = (emailMatch[1] ?? from).toLowerCase().trim();

  console.log(`[webhook/email] Recebido de: ${senderEmail} | Assunto: ${subject}`);

  // Validar se remetente tem cadastro
  const user = await prisma.user.findUnique({
    where: { email: senderEmail },
    include: { company: true },
  });

  if (!user) {
    sendEmail({
      to: senderEmail,
      subject: `Re: ${subject} — Remetente não cadastrado`,
      html: `
        <p>Olá,</p>
        <p>Seu email (<strong>${senderEmail}</strong>) não está cadastrado no helpdesk da Ni Tecnologia.</p>
        <p>Solicite ao administrador que crie uma conta para você.</p>
        <p>Acesse: <a href="${process.env.NEXTAUTH_URL}">${process.env.NEXTAUTH_URL}</a></p>
      `,
    }).catch(console.error);

    return NextResponse.json({ message: "Sender not registered", email: senderEmail });
  }

  // Limpar corpo do email
  const rawText = text || html.replace(/<[^>]+>/g, "");
  const description = rawText
    .split(/\n--\s*\n|\nOn .+wrote:|\n_{3,}|\n-{3,}/)[0]
    .trim()
    .slice(0, 5000) || "(sem conteúdo)";

  const title = subject
    .replace(/^(Re:|Fwd:|Encam\.:)\s*/i, "")
    .trim()
    .slice(0, 255) || "(sem assunto)";

  const ticket = await prisma.$transaction(async (tx) => {
    const number = await nextTicketNumber(tx, user.companyId);
    return tx.ticket.create({
      data: {
        number,
        title,
        description,
        status: "OPEN",
        priority: "MEDIUM",
        companyId: user.companyId,
        createdById: user.id,
      },
    });
  });

  const ticketUrl = `${process.env.NEXTAUTH_URL}/tickets/${ticket.id}`;
  sendEmail({
    to: user.email,
    subject: `[Chamado #${ticket.id.slice(-6)}] Recebido: ${title}`,
    html: `
      <div style="font-family:sans-serif;max-width:500px">
        <p>Olá <strong>${user.name}</strong>,</p>
        <p>Seu chamado foi criado com sucesso! 🎉</p>
        <table style="border-collapse:collapse;margin:16px 0;width:100%">
          <tr><td style="padding:6px 12px 6px 0;color:#6b7280">Número:</td><td><strong>#${ticket.id.slice(-6)}</strong></td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#6b7280">Título:</td><td>${title}</td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#6b7280">Status:</td><td>Aberto</td></tr>
        </table>
        <p><a href="${ticketUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500">Ver chamado</a></p>
      </div>
    `,
  }).catch(console.error);

  return NextResponse.json({ ticketId: ticket.id, title, userId: user.id });
}
