/**
 * Tipos de domínio — fiéis à seção "Design de Baixo Nível" do design.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`.
 */

import type {
  EscalationTrigger,
  MessageType,
  Role,
  ScopeLevel,
} from "@/lib/domain/enums";

/**
 * Mensagem normalizada, independente de canal.
 * Produzida por qualquer `ChannelAdapter.parseInbound`.
 */
export interface InboundMessage {
  companyId: string;
  channelAccountId: string;
  /** E.164 (WhatsApp) ou e-mail. */
  contactExternalId: string;
  contactName?: string;
  type: MessageType;
  body?: string;
  mediaRef?: string;
  /** Id no provedor — base da idempotência (`@@unique([companyId, externalId])`). */
  externalId: string;
  timestamp: Date;
}

/**
 * Mensagem de saída a ser enviada por um `ChannelAdapter.send`.
 */
export interface OutboundMessage {
  conversationId: string;
  type: MessageType;
  body?: string;
  mediaRef?: string;
  /** Obrigatório fora da janela de 24h (WhatsApp). */
  templateName?: string;
  templateParams?: Record<string, string>;
}

/**
 * Capacidades declaradas por um canal/adaptador.
 */
export interface ChannelCapabilities {
  supportsMedia: boolean;
  supportsTemplates: boolean;
  /** WhatsApp = true. */
  hasSessionWindow: boolean;
  /** Ex.: 24 (horas). */
  sessionWindowHours?: number;
}

/**
 * Resultado de um envio por um adaptador de canal.
 */
export interface SendResult {
  externalId: string;
  accepted: boolean;
  error?: string;
}

/**
 * Escopo concedido a uma atribuição de papel.
 * `refId` nulo significa "todo o nível" (ex.: todas as filas do tenant).
 */
export interface RoleScope {
  level: ScopeLevel;
  refId: string | null;
}

/**
 * Atribuição de papel materializada para o motor de RBAC:
 * conjunto de permissões concedidas dentro de um conjunto de escopos.
 */
export interface RoleAssignment {
  /** Permissões no formato `dominio.acao` (ex.: "ticket.assign"). */
  permissions: string[];
  scopes: RoleScope[];
}

/**
 * Usuário da sessão, tal como consumido pelo motor de autorização.
 * `companyId` é sempre derivado no servidor a partir da sessão.
 */
export interface SessionUser {
  id: string;
  companyId: string;
  role: Role;
  roleAssignments: RoleAssignment[];
}

/**
 * Referência a um recurso alvo de uma decisão de autorização.
 * Os campos de escopo permitem a `Authorization.can` testar cobertura.
 */
export interface ResourceRef {
  companyId: string;
  type: string;
  id?: string;
  unitId?: string;
  departmentId?: string;
  teamId?: string;
  queueId?: string;
  categoryId?: string;
}

/**
 * Instantâneo de ticket consumido por `selectEscalations` (função pura).
 * `escalatedTriggers` alimenta o predicado de idempotência `jaEscalado`.
 */
export interface TicketSnapshot {
  id: string;
  companyId: string;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  slaResponseDeadline: Date | null;
  slaResolutionDeadline: Date | null;
  updatedAt: Date;
  escalatedTriggers: EscalationTrigger[];
}
