/**
 * Enums de domínio — espelham exatamente os enums do schema Prisma.
 *
 * Regra: cada membro é um `enum` de STRING cujo valor é idêntico ao nome do
 * membro (ex.: `Priority.LOW === "LOW"`), garantindo compatibilidade direta
 * com as strings persistidas pelo Prisma.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Data Models"). A ordem dos membros segue o design.
 */

export enum Priority {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export enum Impact {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
}

export enum Urgency {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
}

export enum TicketStatus {
  OPEN = "OPEN",
  IN_PROGRESS = "IN_PROGRESS",
  WAITING = "WAITING",
  PENDING_APPROVAL = "PENDING_APPROVAL",
  RESOLVED = "RESOLVED",
  CLOSED = "CLOSED",
  CANCELLED = "CANCELLED",
}

export enum ChannelType {
  WEB = "WEB",
  WHATSAPP = "WHATSAPP",
  EMAIL = "EMAIL",
  PUBLIC_FORM = "PUBLIC_FORM",
  API = "API",
}

export enum ChannelProvider {
  WHATSAPP_CLOUD = "WHATSAPP_CLOUD",
  WHATSAPP_MOCK = "WHATSAPP_MOCK",
  EMAIL_RESEND = "EMAIL_RESEND",
  EMAIL_IMAP = "EMAIL_IMAP",
  INTERNAL = "INTERNAL",
}

export enum MessageDirection {
  INBOUND = "INBOUND",
  OUTBOUND = "OUTBOUND",
}

export enum MessageType {
  TEXT = "TEXT",
  IMAGE = "IMAGE",
  DOCUMENT = "DOCUMENT",
  AUDIO = "AUDIO",
  VIDEO = "VIDEO",
  TEMPLATE = "TEMPLATE",
  SYSTEM = "SYSTEM",
}

export enum ConversationState {
  OPEN = "OPEN",
  PENDING = "PENDING",
  RESOLVED = "RESOLVED",
  EXPIRED = "EXPIRED",
}

export enum ApprovalState {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  CANCELLED = "CANCELLED",
}

export enum EscalationTrigger {
  RESPONSE_BREACH = "RESPONSE_BREACH",
  RESOLUTION_BREACH = "RESOLUTION_BREACH",
  INACTIVITY = "INACTIVITY",
  MANUAL = "MANUAL",
}

export enum OutboxState {
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  SENT = "SENT",
  FAILED = "FAILED",
}

export enum ScopeLevel {
  TENANT = "TENANT",
  UNIT = "UNIT",
  DEPARTMENT = "DEPARTMENT",
  TEAM = "TEAM",
  QUEUE = "QUEUE",
  CATEGORY = "CATEGORY",
  TICKET = "TICKET",
}

/**
 * Role corporativo granular (ampliação do `Role` existente).
 * Pertence aos enums de domínio pois é consumido pelo motor de RBAC.
 * Ordem conforme o design (seção "Data Models").
 */
export enum Role {
  SUPERADMIN = "SUPERADMIN",
  ADMIN = "ADMIN",
  SERVICE_MANAGER = "SERVICE_MANAGER",
  SUPERVISOR = "SUPERVISOR",
  AGENT = "AGENT",
  SPECIALIST = "SPECIALIST",
  APPROVER = "APPROVER",
  AUDITOR = "AUDITOR",
  READONLY = "READONLY",
  INTEGRATION = "INTEGRATION",
  SERVICE_ACCOUNT = "SERVICE_ACCOUNT",
  CLIENT = "CLIENT",
}
