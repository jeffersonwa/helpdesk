/**
 * Testes do `EmailAdapter` (task 18.2).
 *
 * Puros e determinísticos — todas as dependências (verificador de assinatura,
 * resolvedor de conta, cliente IMAP, enviador de e-mail) são INJETADAS via
 * stubs. NÃO há acesso a rede, DB ou IMAP real.
 *
 * Cobertura (Req. 7.2, 7.4, 7.5, 7.6, 7.7):
 *  - Assinatura inválida/ausente rejeita, sem `InboundMessage`.
 *  - Retry IMAP: falha duas vezes e sucede na terceira; falha 3x → erro.
 *  - Vínculo de thread: mensagem parseada carrega o `Message-ID` (externalId).
 *  - Sem correspondência: `parseInbound` ainda produz a `InboundMessage`
 *    (a criação de nova conversa+ticket é responsabilidade do IngestionRouter).
 *  - Resposta preserva cabeçalhos de thread (In-Reply-To/References).
 */

import { describe, expect, it, vi } from "vitest";

import type { ChannelAccountRef, RawRequest } from "@/lib/channels/adapter";
import {
  EmailAdapter,
  ImapFetchError,
  createEmailAdapter,
  type ImapClient,
  type RawEmail,
  type SendEmailParams,
} from "@/lib/channels/email/adapter";
import {
  ChannelProvider,
  ChannelType,
  MessageType,
} from "@/lib/domain/enums";
import type { OutboundMessage } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const ACCOUNT = { id: "acc-1", companyId: "co-1" } as const;

function resolveAccountOk() {
  return vi.fn(async (_to: string) => ({ ...ACCOUNT }));
}
function resolveAccountNone() {
  return vi.fn(async (_to: string) => null);
}
function sendEmailOk(id = "prov-msg-1") {
  return vi.fn(async (_p: SendEmailParams) => ({ id }));
}

function webhookRequest(body: unknown): RawRequest {
  return {
    method: "POST",
    headers: { "x-resend-signature": "sig" },
    query: {},
    rawBody: JSON.stringify(body),
  };
}

const SAMPLE_EMAIL = {
  messageId: "<abc123@mail.example.com>",
  from: "Maria Silva <maria@cliente.com>",
  to: "suporte@empresa.com",
  subject: "Preciso de ajuda",
  text: "Olá, meu sistema está fora do ar.",
} as const;

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

describe("EmailAdapter.capabilities", () => {
  it("declara mídia, sem templates e sem janela de sessão", () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    expect(adapter.type).toBe(ChannelType.EMAIL);
    expect(adapter.capabilities()).toEqual({
      supportsMedia: true,
      supportsTemplates: false,
      hasSessionWindow: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Req. 7.2 — assinatura inválida rejeita sem InboundMessage
// ---------------------------------------------------------------------------

describe("EmailAdapter.verifyInbound (Req. 7.2)", () => {
  it("aceita quando o verificador de assinatura confere", async () => {
    const verify = vi.fn(() => true);
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      verifyProviderSignature: verify,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    await expect(adapter.verifyInbound(webhookRequest(SAMPLE_EMAIL))).resolves.toBe(
      true,
    );
    expect(verify).toHaveBeenCalledOnce();
  });

  it("rejeita assinatura inválida (verificador retorna false)", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      verifyProviderSignature: () => false,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    await expect(
      adapter.verifyInbound(webhookRequest(SAMPLE_EMAIL)),
    ).resolves.toBe(false);
  });

  it("rejeita (fail-closed) quando não há verificador configurado", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    await expect(
      adapter.verifyInbound(webhookRequest(SAMPLE_EMAIL)),
    ).resolves.toBe(false);
  });

  it("rejeita quando o verificador lança (não vaza exceção)", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      verifyProviderSignature: () => {
        throw new Error("boom");
      },
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    await expect(
      adapter.verifyInbound(webhookRequest(SAMPLE_EMAIL)),
    ).resolves.toBe(false);
  });

  it("no modo IMAP, webhook não é verificado (retorna false)", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_IMAP,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    await expect(
      adapter.verifyInbound(webhookRequest(SAMPLE_EMAIL)),
    ).resolves.toBe(false);
  });

  it("assinatura inválida NÃO deve ser processada em InboundMessage pela borda", async () => {
    // A borda só chama parseInbound quando verifyInbound retorna true.
    // Aqui documentamos o contrato: verify=false ⇒ nenhuma InboundMessage.
    const resolve = resolveAccountOk();
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      verifyProviderSignature: () => false,
      resolveAccountByAddress: resolve,
      sendEmail: sendEmailOk(),
    });
    const verified = await adapter.verifyInbound(webhookRequest(SAMPLE_EMAIL));
    expect(verified).toBe(false);
    // Como a borda não prossegue, o resolvedor de conta nunca é chamado.
    expect(resolve).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req. 7.1, 7.5, 7.6 — parseInbound
// ---------------------------------------------------------------------------

describe("EmailAdapter.parseInbound", () => {
  it("normaliza um e-mail e carrega o Message-ID em externalId (thread — Req. 7.5)", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    const email = {
      ...SAMPLE_EMAIL,
      inReplyTo: "<parent@mail.example.com>",
      references: ["<root@mail.example.com>", "<parent@mail.example.com>"],
    };
    const msgs = await adapter.parseInbound(webhookRequest(email));
    expect(msgs).toHaveLength(1);
    const m = msgs[0];
    // externalId = Message-ID → idempotência e vínculo de thread pelo router.
    expect(m.externalId).toBe(SAMPLE_EMAIL.messageId);
    expect(m.type).toBe(MessageType.TEXT);
    expect(m.contactExternalId).toBe("maria@cliente.com");
    expect(m.contactName).toBe("Maria Silva");
    expect(m.body).toBe(SAMPLE_EMAIL.text);
    expect(m.companyId).toBe(ACCOUNT.companyId);
    expect(m.channelAccountId).toBe(ACCOUNT.id);
  });

  it("sem correspondência de thread ainda produz a InboundMessage (criação é do router — Req. 7.6)", async () => {
    // Um e-mail totalmente novo (sem In-Reply-To/References). parseInbound
    // apenas normaliza; criar conversa+ticket é responsabilidade do
    // IngestionRouter (coberto pelos testes do router).
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    const msgs = await adapter.parseInbound(webhookRequest(SAMPLE_EMAIL));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].externalId).toBe(SAMPLE_EMAIL.messageId);
  });

  it("descarta quando o endereço de destino não resolve tenant", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountNone(),
      sendEmail: sendEmailOk(),
    });
    const msgs = await adapter.parseInbound(webhookRequest(SAMPLE_EMAIL));
    expect(msgs).toEqual([]);
  });

  it("usa HTML sem tags como fallback de corpo quando não há texto puro", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    const email = {
      messageId: "<html1@x>",
      from: "ana@cliente.com",
      to: "suporte@empresa.com",
      html: "<p>Olá</p><br><b>mundo</b>",
    };
    const msgs = await adapter.parseInbound(webhookRequest(email));
    expect(msgs[0].body).toBe("Olá\n\nmundo");
    // Sem display name → contactName ausente; endereço puro preservado.
    expect(msgs[0].contactExternalId).toBe("ana@cliente.com");
    expect(msgs[0].contactName).toBeUndefined();
  });

  it("mantém a mensagem como TEXT e guarda referência de anexo em mediaRef", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    const email = {
      ...SAMPLE_EMAIL,
      attachments: [{ id: "att-9", filename: "erro.png" }],
    };
    const msgs = await adapter.parseInbound(webhookRequest(email));
    expect(msgs[0].type).toBe(MessageType.TEXT);
    expect(msgs[0].mediaRef).toBe("att-9");
  });

  it("retorna vazio para JSON malformado", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    const req: RawRequest = {
      method: "POST",
      headers: {},
      query: {},
      rawBody: "{not json",
    };
    await expect(adapter.parseInbound(req)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Req. 7.3, 7.4 — IMAP polling e retry
// ---------------------------------------------------------------------------

describe("EmailAdapter.pollOnce (Req. 7.3, 7.4)", () => {
  it("normaliza os e-mails não lidos em uma única passagem", async () => {
    const emails: RawEmail[] = [
      {
        messageId: "<m1@x>",
        from: "u1@cliente.com",
        to: "suporte@empresa.com",
        text: "um",
      },
      {
        messageId: "<m2@x>",
        from: "u2@cliente.com",
        to: "suporte@empresa.com",
        text: "dois",
      },
    ];
    const imap: ImapClient = { fetchUnseen: vi.fn(async () => emails) };
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_IMAP,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    const result = await adapter.pollOnce({ imap });
    expect(result.attempts).toBe(1);
    expect(result.messages.map((m) => m.externalId)).toEqual([
      "<m1@x>",
      "<m2@x>",
    ]);
  });

  it("faz retry: falha duas vezes e sucede na terceira tentativa", async () => {
    let calls = 0;
    const fetchUnseen = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("IMAP timeout");
      }
      return [
        {
          messageId: "<ok@x>",
          from: "u@cliente.com",
          to: "suporte@empresa.com",
          text: "ok",
        },
      ] satisfies RawEmail[];
    });
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_IMAP,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    const result = await adapter.pollOnce({ imap: { fetchUnseen } });
    expect(fetchUnseen).toHaveBeenCalledTimes(3);
    expect(result.attempts).toBe(3);
    expect(result.messages).toHaveLength(1);
  });

  it("falha 3x → lança ImapFetchError com attempts=3 (indicação de erro)", async () => {
    const fetchUnseen = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_IMAP,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    await expect(adapter.pollOnce({ imap: { fetchUnseen } })).rejects.toThrow(
      ImapFetchError,
    );
    expect(fetchUnseen).toHaveBeenCalledTimes(3);
    // Confere metadata do erro.
    try {
      await adapter.pollOnce({ imap: { fetchUnseen } });
    } catch (err) {
      expect(err).toBeInstanceOf(ImapFetchError);
      expect((err as ImapFetchError).attempts).toBe(3);
      expect((err as ImapFetchError).code).toBe("IMAP_FETCH_FAILED");
    }
  });

  it("expõe o intervalo de polling normalizado ao range 30–300s (padrão 60)", () => {
    const def = new EmailAdapter({
      provider: ChannelProvider.EMAIL_IMAP,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
    });
    expect(def.pollIntervalSeconds).toBe(60);

    const low = new EmailAdapter({
      provider: ChannelProvider.EMAIL_IMAP,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
      pollIntervalSeconds: 5,
    });
    expect(low.pollIntervalSeconds).toBe(30);

    const high = new EmailAdapter({
      provider: ChannelProvider.EMAIL_IMAP,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: sendEmailOk(),
      pollIntervalSeconds: 9999,
    });
    expect(high.pollIntervalSeconds).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Req. 7.7 — resposta preserva cabeçalhos de thread
// ---------------------------------------------------------------------------

describe("EmailAdapter.send (Req. 7.7)", () => {
  const account: ChannelAccountRef = {
    id: "acc-1",
    companyId: "co-1",
    type: ChannelType.EMAIL,
    provider: ChannelProvider.EMAIL_RESEND,
    externalId: "suporte@empresa.com",
    secretRef: "secret://email/co-1",
  };

  it("preserva In-Reply-To e References ao responder", async () => {
    const sendEmail = sendEmailOk("resp-1");
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail,
    });
    const msg: OutboundMessage = {
      conversationId: "conv-1",
      type: MessageType.TEXT,
      body: "Estamos verificando, retornamos em breve.",
      templateParams: {
        to: "maria@cliente.com",
        from: "suporte@empresa.com",
        subject: "Re: Preciso de ajuda",
        inReplyTo: "<abc123@mail.example.com>",
        references: "<root@x> <abc123@mail.example.com>",
      },
    };
    const result = await adapter.send(account, msg);
    expect(result.accepted).toBe(true);
    expect(result.externalId).toBe("resp-1");

    expect(sendEmail).toHaveBeenCalledOnce();
    const params = sendEmail.mock.calls[0][0];
    expect(params.to).toBe("maria@cliente.com");
    expect(params.subject).toBe("Re: Preciso de ajuda");
    expect(params.text).toBe("Estamos verificando, retornamos em breve.");
    // Cabeçalhos de thread preservados (Req. 7.7).
    expect(params.inReplyTo).toBe("<abc123@mail.example.com>");
    expect(params.references).toEqual([
      "<root@x>",
      "<abc123@mail.example.com>",
    ]);
  });

  it("retorna accepted:false quando o envio falha", async () => {
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail: vi.fn(async () => {
        throw new Error("SMTP 550");
      }),
    });
    const result = await adapter.send(account, {
      conversationId: "conv-1",
      type: MessageType.TEXT,
      body: "x",
      templateParams: { to: "maria@cliente.com", subject: "Re: x" },
    });
    expect(result.accepted).toBe(false);
    expect(result.externalId).toBe("");
    expect(result.error).toContain("SMTP 550");
  });

  it("rejeita quando o destinatário está ausente", async () => {
    const sendEmail = sendEmailOk();
    const adapter = createEmailAdapter({
      provider: ChannelProvider.EMAIL_RESEND,
      resolveAccountByAddress: resolveAccountOk(),
      sendEmail,
    });
    const result = await adapter.send(account, {
      conversationId: "conv-1",
      type: MessageType.TEXT,
      body: "x",
    });
    expect(result.accepted).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
