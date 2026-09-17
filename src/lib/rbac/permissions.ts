/**
 * Catálogo de permissões e registro de tipos de recurso do RBAC.
 *
 * SEGURANÇA (fail-closed): tanto as ações quanto os tipos de recurso são
 * conjuntos FECHADOS. Qualquer ação fora de {@link PERMISSIONS} ou qualquer
 * tipo de recurso fora de {@link RESOURCE_TYPES} deve ser NEGADO por padrão
 * pelo motor de autorização (Req. 2.9, 2.10 — fail-closed).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seções "Modelo de RBAC e Autorização" e "Design de Baixo Nível").
 *
 * Formato das permissões: `dominio.acao` (ex.: "ticket.assign").
 */

/**
 * Catálogo canônico de ações autorizáveis, no formato `dominio.acao`.
 * `as const` preserva os literais para derivar o tipo-união {@link Permission}.
 */
export const PERMISSIONS = [
  "ticket.create",
  "ticket.read",
  "ticket.update",
  "ticket.assign",
  "ticket.delete",
  "conversation.read",
  "conversation.reply",
  "queue.manage",
  "catalog.manage",
  "org.manage",
  "rbac.manage",
  "channel.configure",
  "kb.manage",
  "report.view",
  "automation.manage",
  "webhook.manage",
  "approval.decide",
  "audit.read",
  "lgpd.manage",
] as const;

/**
 * União de todas as ações reconhecidas do catálogo.
 */
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Conjunto imutável para verificação O(1) de pertencimento ao catálogo.
 * `ReadonlySet<string>` aceita qualquer `string` como entrada de consulta,
 * o que é intencional: o motor recebe `action: string` e precisa negar
 * ações desconhecidas sem estreitar o tipo prematuramente.
 */
export const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

/**
 * Predicado (type guard) que reconhece uma ação do catálogo.
 * Retorna `false` para qualquer valor fora do catálogo (fail-closed).
 */
export function isKnownPermission(action: string): action is Permission {
  return PERMISSION_SET.has(action);
}

/**
 * Registro de tipos de recurso reconhecidos. Um `ResourceRef.type` fora
 * deste conjunto é NEGADO por padrão pelo motor de autorização (fail-closed).
 */
export const RESOURCE_TYPES = [
  "ticket",
  "conversation",
  "queue",
  "category",
  "department",
  "unit",
  "team",
  "kbArticle",
  "report",
  "channel",
  "role",
  "webhook",
  "automation",
  "auditLog",
] as const;

/**
 * União de todos os tipos de recurso reconhecidos.
 */
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/**
 * Conjunto imutável para verificação O(1) de tipo de recurso reconhecido.
 */
export const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set<string>(
  RESOURCE_TYPES,
);

/**
 * Predicado (type guard) que reconhece um tipo de recurso do registro.
 * Retorna `false` para qualquer valor fora do registro (fail-closed).
 */
export function isKnownResourceType(type: string): type is ResourceType {
  return RESOURCE_TYPE_SET.has(type);
}
