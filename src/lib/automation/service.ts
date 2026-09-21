/**
 * AutomationService — automação de tarefas repetitivas por conta de serviço.
 *
 * Tarefa 28.1. Fonte autoritativa:
 * `.kiro/specs/helpdesk-omnichannel/design.md` (seção "Automação") e
 * requirement 16.
 *
 * Contrato (Req. 16.1, 16.2, 16.3, 16.4):
 *  - Execução SEMPRE sob o tenant da conta de serviço (`ServiceAccount.companyId`),
 *    nunca sob um tenant vindo do payload (Req. 16.1 + princípio inviolável de
 *    multi-tenancy).
 *  - Ao satisfazer a condição, a ação é DESPACHADA via outbox (enfileira um
 *    `OutboxEvent` do tipo `automation.action`) e a execução é AUDITADA — ambos
 *    na MESMA transação, de modo que a ação e seu registro de auditoria sejam
 *    atômicos. O worker do outbox entrega a ação em ≤60s (Req. 16.2).
 *  - Falha na fase de despacho: como enfileiramento + auditoria ocorrem na mesma
 *    transação, uma falha reverte tudo — NENHUM efeito parcial (Req. 16.3). A
 *    reexecução com backoff (≤3 tentativas) é responsabilidade do worker do
 *    outbox, que lê `maxAttempts` do payload enfileirado. Registramos também um
 *    audit de FALHA quando o despacho não pôde ser enfileirado.
 *  - Limite de 100 regras ATIVAS por tenant, verificado na criação (Req. 16.4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERSISTÊNCIA DAS REGRAS — decisão de arquitetura:
 *
 *   O schema Prisma atual NÃO possui uma tabela `AutomationRule`. Nesta fase,
 *   modelamos as regras como uma ESTRUTURA TIPADA EM CÓDIGO ({@link AutomationRule})
 *   fornecida pela camada chamadora (ex.: configuração por tenant carregada em
 *   memória) e roteamos toda a EXECUÇÃO pelo `OutboxEvent` já existente.
 *
 *   A contagem de "regras ativas" para o limite de 100 (Req. 16.4) também é
 *   avaliada sobre a lista tipada fornecida — não há tabela para consultar.
 *
 *   FUTURO (migração dedicada): materializar uma tabela `AutomationRule`
 *   (id, companyId, name, active, trigger/condition JSON, action JSON,
 *   createdAt) com `@@index([companyId, active])`, e então a contagem do limite
 *   e a listagem de regras passariam a consultar o banco. Documentado aqui para
 *   rastreio; ver NOTA de migração ao final do arquivo.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * _Requisitos: 16.1, 16.2, 16.3, 16.4_
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { enqueue, type OutboxCapableClient } from "@/lib/outbox/dispatcher";
import { recordAudit, type AuditWriter } from "@/lib/audit/service";

/** Tipo de `OutboxEvent` que carrega uma ação de automação a ser executada. */
export const AUTOMATION_ACTION_TYPE = "automation.action" as const;

/** Máximo de tentativas de reexecução da ação via outbox (Req. 16.3). */
export const AUTOMATION_MAX_ATTEMPTS = 3;

/** Limite de regras ATIVAS por tenant (Req. 16.4). */
export const AUTOMATION_MAX_ACTIVE_RULES = 100;

/**
 * Conta de serviço sob a qual a automação executa. O `companyId` daqui é a
 * ÚNICA fonte de tenant para toda a execução (Req. 16.1).
 */
export interface ServiceAccount {
  id: string;
  companyId: string;
}

/**
 * Condição de uma regra: comparação simples de igualdade de um campo do fato
 * (`TicketFact`/evento) com um valor esperado. Mantida deliberadamente simples
 * e PURA para ser 100% testável sem I/O.
 */
export interface AutomationCondition {
  field: string;
  equals: string | number | boolean | null;
}

/** Ação a despachar quando a condição é satisfeita. */
export interface AutomationAction {
  /** Ex.: "ticket.assign", "ticket.setPriority", "notify". */
  kind: string;
  /** Parâmetros da ação (serializados no payload do outbox). */
  params: Record<string, unknown>;
}

/**
 * Regra de automação como ESTRUTURA TIPADA EM CÓDIGO (não persistida no schema
 * atual — ver nota de arquitetura no topo). `companyId` deve casar com o da
 * conta de serviço; é validado na criação/execução.
 */
export interface AutomationRule {
  id: string;
  companyId: string;
  name: string;
  active: boolean;
  /** Todas as condições precisam ser satisfeitas (AND). Vazio = sempre. */
  conditions: AutomationCondition[];
  action: AutomationAction;
}

/** Fato de entrada avaliado pelas condições (ex.: snapshot de ticket/evento). */
export type AutomationFact = Record<string, unknown>;

/** Erro de violação do limite de regras ativas por tenant (Req. 16.4). */
export class AutomationRuleLimitError extends Error {
  readonly code = "AUTOMATION_RULE_LIMIT" as const;

  constructor(limit: number) {
    super(`Limite de ${limit} regras de automação ativas por tenant excedido`);
    this.name = "AutomationRuleLimitError";
    Object.setPrototypeOf(this, AutomationRuleLimitError.prototype);
  }
}

/** Erro de incompatibilidade de tenant (regra de outro tenant). */
export class AutomationTenantMismatchError extends Error {
  readonly code = "AUTOMATION_TENANT_MISMATCH" as const;

  constructor() {
    super("Regra de automação não pertence ao tenant da conta de serviço");
    this.name = "AutomationTenantMismatchError";
    Object.setPrototypeOf(this, AutomationTenantMismatchError.prototype);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Avaliação de condição — PURA, sem I/O (100% testável)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Avalia se um fato satisfaz UMA condição (igualdade estrita do campo).
 * Campo ausente no fato nunca casa (fail-closed), salvo quando o esperado é
 * explicitamente `null` E o campo é ausente/`null`.
 */
export function evaluateCondition(
  condition: AutomationCondition,
  fact: AutomationFact,
): boolean {
  const actual = fact[condition.field];
  if (condition.equals === null) {
    return actual === undefined || actual === null;
  }
  return actual === condition.equals;
}

/**
 * Avalia se um fato satisfaz TODAS as condições da regra (AND). Regra sem
 * condições é sempre satisfeita. Função PURA.
 */
export function conditionsMet(
  rule: AutomationRule,
  fact: AutomationFact,
): boolean {
  return rule.conditions.every((c) => evaluateCondition(c, fact));
}

// ───────────────────────────────────────────────────────────────────────────
// Limite de regras ativas (Req. 16.4) — avaliado sobre a lista tipada
// ───────────────────────────────────────────────────────────────────────────

/** Conta as regras ATIVAS de um tenant dentro da lista fornecida. */
export function countActiveRules(
  rules: AutomationRule[],
  companyId: string,
): number {
  return rules.filter((r) => r.active && r.companyId === companyId).length;
}

/**
 * Valida a criação de uma nova regra contra o limite de 100 ativas por tenant
 * (Req. 16.4). Se a nova regra for ativa E o tenant já estiver no limite,
 * lança {@link AutomationRuleLimitError}. Retorna a nova lista com a regra
 * anexada quando aceita.
 *
 * @throws {AutomationTenantMismatchError} se a regra não for do tenant da conta.
 * @throws {AutomationRuleLimitError} se exceder o limite de ativas.
 */
export function createRule(
  account: ServiceAccount,
  existing: AutomationRule[],
  rule: AutomationRule,
): AutomationRule[] {
  if (rule.companyId !== account.companyId) {
    throw new AutomationTenantMismatchError();
  }
  if (
    rule.active &&
    countActiveRules(existing, account.companyId) >= AUTOMATION_MAX_ACTIVE_RULES
  ) {
    throw new AutomationRuleLimitError(AUTOMATION_MAX_ACTIVE_RULES);
  }
  return [...existing, rule];
}

// ───────────────────────────────────────────────────────────────────────────
// Execução — despacho via outbox + auditoria, na MESMA transação (Req. 16.2/16.3)
// ───────────────────────────────────────────────────────────────────────────

/** Payload do `OutboxEvent` que carrega a ação a executar (com política de retry). */
export type AutomationOutboxPayload = {
  ruleId: string;
  actionKind: string;
  params: Prisma.JsonObject;
  /** Tentativas máximas de reexecução (o worker do outbox aplica o backoff). */
  maxAttempts: number;
};

/** Cliente transacional mínimo capaz de enfileirar outbox E auditar. */
export type AutomationTx = OutboxCapableClient & AuditWriter;

/** Cliente com `$transaction`, para atomicidade despacho+auditoria. */
export type AutomationClient = Pick<PrismaClient, "$transaction">;

/** Resultado de uma tentativa de execução de regra. */
export interface RunRuleResult {
  /** `true` quando a condição foi satisfeita e a ação foi despachada. */
  dispatched: boolean;
  /** Id do `OutboxEvent` criado (quando despachado). */
  outboxEventId?: string;
}

/**
 * Executa UMA regra contra um fato, sob o tenant da conta de serviço (Req. 16.1).
 *
 * Fluxo:
 *  1. Valida que a regra é do tenant da conta (senão {@link AutomationTenantMismatchError}).
 *  2. Se a regra está inativa OU a condição não é satisfeita → NÃO despacha
 *     (retorna `dispatched: false`), sem efeitos.
 *  3. Se satisfeita → dentro de UMA transação: enfileira o `OutboxEvent` da ação
 *     E grava exatamente um `AuditLog` de execução. Atomicidade garante que não
 *     há efeito parcial: ou ambos gravam, ou nenhum (Req. 16.3). O worker do
 *     outbox entrega a ação (≤60s) e reexecuta com backoff até `maxAttempts`
 *     (Req. 16.2, 16.3).
 *
 * Se a transação FALHAR (ex.: banco indisponível), o erro é propagado e um
 * audit de FALHA é gravado FORA da transação revertida (best-effort), sem
 * aplicar efeitos parciais.
 */
export async function runRule(
  client: AutomationClient,
  account: ServiceAccount,
  rule: AutomationRule,
  fact: AutomationFact,
  now: () => Date = () => new Date(),
): Promise<RunRuleResult> {
  if (rule.companyId !== account.companyId) {
    throw new AutomationTenantMismatchError();
  }

  // Regra inativa ou condição não satisfeita → nada a fazer, sem efeitos.
  if (!rule.active || !conditionsMet(rule, fact)) {
    return { dispatched: false };
  }

  const payload: AutomationOutboxPayload = {
    ruleId: rule.id,
    actionKind: rule.action.kind,
    params: rule.action.params as Prisma.JsonObject,
    maxAttempts: AUTOMATION_MAX_ATTEMPTS,
  };

  try {
    const outboxEventId = await client.$transaction(async (tx) => {
      // Despacho da ação via outbox (tenant SEMPRE da conta de serviço).
      const id = await enqueue(
        tx as unknown as OutboxCapableClient,
        {
          companyId: account.companyId,
          type: AUTOMATION_ACTION_TYPE,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
        now,
      );
      // Auditoria de execução — mesma transação (atômico, sem efeito parcial).
      await recordAudit(tx as unknown as AuditWriter, {
        companyId: account.companyId,
        actorId: account.id,
        action: "automation.execute",
        entityType: "automation",
        entityId: rule.id,
        after: {
          ruleName: rule.name,
          actionKind: rule.action.kind,
          outboxEventId: id,
        },
      });
      return id;
    });

    return { dispatched: true, outboxEventId };
  } catch (err) {
    // Falha de despacho: a transação reverteu (nenhum efeito parcial, Req. 16.3).
    // Grava audit de FALHA best-effort, FORA da transação revertida.
    await recordFailureAudit(client, account, rule, err);
    throw err;
  }
}

/**
 * Grava (best-effort) um `AuditLog` de FALHA de execução de automação (Req. 16.3).
 * Usa o `$transaction` do client apenas para obter um writer; nunca engole o
 * erro original (que é relançado pelo chamador).
 */
async function recordFailureAudit(
  client: AutomationClient,
  account: ServiceAccount,
  rule: AutomationRule,
  err: unknown,
): Promise<void> {
  try {
    await client.$transaction(async (tx) => {
      await recordAudit(tx as unknown as AuditWriter, {
        companyId: account.companyId,
        actorId: account.id,
        action: "automation.execute.failed",
        entityType: "automation",
        entityId: rule.id,
        after: {
          ruleName: rule.name,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    });
  } catch {
    // Se a própria auditoria de falha falhar, não mascaramos o erro original;
    // apenas evitamos lançar um erro secundário.
  }
}

/** Superfície pública do AutomationService. */
export const AutomationService = {
  evaluateCondition,
  conditionsMet,
  countActiveRules,
  createRule,
  runRule,
} as const;

/* ─────────────────────────────────────────────────────────────────────────────
 * NOTA DE MIGRAÇÃO — tabela AutomationRule (trabalho futuro).
 *
 * O schema atual não possui `AutomationRule`; as regras são estruturas tipadas
 * em código fornecidas pela camada de configuração. Uma migração futura deve
 * introduzir:
 *
 *   model AutomationRule {
 *     id         String   @id @default(cuid())
 *     companyId  String
 *     name       String
 *     active     Boolean  @default(true)
 *     conditions Json     // AutomationCondition[]
 *     action     Json     // AutomationAction
 *     createdAt  DateTime @default(now())
 *     updatedAt  DateTime @updatedAt
 *     company    Company  @relation(fields: [companyId], references: [id])
 *     @@index([companyId, active])
 *   }
 *
 * Com a tabela, `countActiveRules` passaria a `prisma.automationRule.count`
 * ({ where: { companyId, active: true } }) e a criação verificaria o limite de
 * 100 contra o banco. A EXECUÇÃO continua roteada pelo `OutboxEvent`
 * (`automation.action`), preservando atomicidade despacho+auditoria e o retry
 * com backoff do worker.
 * ───────────────────────────────────────────────────────────────────────────*/
