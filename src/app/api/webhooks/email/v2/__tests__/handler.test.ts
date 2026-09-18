/**
 * Testes do handler de e-mail OFICIAL (v2) — tarefa 21.2.
 *
 * Estilo unit: `handleEmailPost` com STUBS de adapter + router (sem DB/rede).
 * Cobre: assinatura inválida → 401 sem parse/route; válida → 200 e roteia.
 */

import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter, RawRequest } from "@/lib/channels/adapter";
import { ChannelProvider, ChannelType, MessageType } from "@/lib/domain";
import type { InboundMessage } from "@/lib/domain";

import { handleEmailPost } from "../handler";

function makeAdapter(opts: {
  verify: boolean;
  messages?: InboundMessage[];
}): ChannelAdapter & {
  verifySpy: ReturnType<typeof vi.fn>;
  parseSpy: ReturnType<typeof vi.fn>;
} {
  const verifySpy = vi.fn(async () => opts.verify);
  const parseSpy = vi.fn(async () => opts.messages ?? []);
  return {
    type: ChannelType.EMAIL,
    provider: ChannelProvider.EMAIL_RESEND,
    capabilities: () => ({
      supportsMedia: true,
      supportsTemplates: false,
      hasSessionWindow: false,
    }),
    verifyInbound: verifySpy as unknown as ChannelAdapter["verifyInbound"],
    parseInbound: parseSpy as unknown as ChannelAdapter["parseInbound"],
    send: vi.fn(async () => ({ externalId: "", accepted: false })),
    verifySpy,
    parseSpy,
  };
}

const req: RawRequest = {
  method: "POST",
  headers: { "x-webhook-token": "tok" },
  query: {},
  rawBody: JSON.stringify({ messageId: "<a@b>", from: "a@b.com", to: "t@x.com" }),
};

const msg: InboundMessage = {
  companyId: "c1",
  channelAccountId: "acc-mail",
  contactExternalId: "a@b.com",
  type: MessageType.TEXT,
  externalId: "<a@b>",
  timestamp: new Date(),
};

describe("handleEmailPost", () => {
  it("assinatura inválida → 401 e NÃO parseia/roteia", async () => {
    const adapter = makeAdapter({ verify: false });
    const route = vi.fn(async () => undefined);
    const res = await handleEmailPost(req, { adapter, route });
    expect(res.status).toBe(401);
    expect(adapter.parseSpy).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it("assinatura válida → 200 e roteia a mensagem", async () => {
    const adapter = makeAdapter({ verify: true, messages: [msg] });
    const route = vi.fn(async () => undefined);
    const res = await handleEmailPost(req, { adapter, route });
    expect(res.status).toBe(200);
    expect(adapter.parseSpy).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ received: 1, routed: 1 });
  });
});
