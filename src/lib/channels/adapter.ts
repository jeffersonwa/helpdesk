/**
 * Interface `ChannelAdapter` e tipos de suporte da camada de ingestão omnichannel.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seções "Camada de Ingestão Omnichannel" e "Design de Baixo Nível").
 *
 * Princípios (Req 5.1, 5.7):
 *  - Contrato ÚNICO para todos os canais (WhatsApp Cloud, WhatsApp MOCK,
 *    e-mail, formulário público, API). Mock e real são intercambiáveis.
 *  - `InboundMessage`, `OutboundMessage`, `ChannelCapabilities`, `SendResult`,
 *    `ChannelType` e `ChannelProvider` vêm do domínio (`@/lib/domain`) — NUNCA
 *    são redefinidos aqui.
 *  - Segredos jamais trafegam no código/objetos: `ChannelAccountRef.secretRef`
 *    é uma REFERÊNCIA (resolvida de env/secret manager no momento do envio).
 */

import type {
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "@/lib/domain";
import type { ChannelProvider, ChannelType } from "@/lib/domain";

/**
 * Representação agnóstica de canal de uma requisição/evento HTTP de entrada.
 *
 * Mínima, porém suficiente para:
 *  - handshake GET do WhatsApp (parâmetros `hub.*` em `query`);
 *  - POST do WhatsApp (cabeçalho `X-Hub-Signature-256` + `rawBody`);
 *  - webhook de e-mail (assinatura do provedor no cabeçalho + corpo bruto);
 *  - formulário público (corpo bruto + token).
 *
 * `rawBody` é uma STRING com os bytes exatos recebidos: essencial para a
 * verificação HMAC, que precisa assinar exatamente o payload recebido (não
 * um JSON reserializado, que poderia diferir em espaços/ordem).
 */
export interface RawRequest {
  method: string;
  /** Cabeçalhos normalizados (idealmente com chaves em minúsculas). */
  headers: Record<string, string>;
  /** Parâmetros de query string (ex.: `hub.mode`, `hub.challenge`). */
  query: Record<string, string>;
  /** Corpo bruto exato, como recebido — base da verificação HMAC. */
  rawBody: string;
}

/**
 * Referência mínima que um adaptador precisa para enviar/escopar mensagens.
 *
 * NÃO contém segredos: `secretRef` aponta para o segredo (env/secret manager),
 * resolvido apenas no momento do envio. Isso mantém a Property 11 (não
 * vazamento de segredos) por construção.
 */
export interface ChannelAccountRef {
  /** Id da `ChannelAccount` no banco. */
  id: string;
  /** Tenant dono da conta — sempre derivado no servidor. */
  companyId: string;
  type: ChannelType;
  provider: ChannelProvider;
  /** Id externo (ex.: `phone_number_id` do WhatsApp, caixa de e-mail). */
  externalId?: string | null;
  /** REFERÊNCIA a um segredo — nunca o valor do segredo. */
  secretRef: string;
}

/**
 * Contrato único para mock e real (design — "Design de Baixo Nível").
 *
 * Qualquer canal implementa esta interface; o `IngestionRouter` e os workers
 * dependem apenas dela, permitindo trocar o provider por variável de ambiente
 * sem alterar o núcleo (Req 5.1, 5.7).
 */
export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly provider: ChannelProvider;
  /** Capacidades declaradas do canal (mídia, templates, janela de sessão). */
  capabilities(): ChannelCapabilities;
  /** Verifica assinatura/verify token do evento bruto (antes de qualquer efeito). */
  verifyInbound(req: RawRequest): Promise<boolean>;
  /** Normaliza o evento bruto em zero ou mais `InboundMessage`. */
  parseInbound(req: RawRequest): Promise<InboundMessage[]>;
  /** Envia uma mensagem de saída pela conta informada. */
  send(account: ChannelAccountRef, msg: OutboundMessage): Promise<SendResult>;
}
