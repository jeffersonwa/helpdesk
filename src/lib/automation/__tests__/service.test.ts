/**
 * Testes unitários do AutomationService (tarefa 28.2).
 *
 * `$transaction`, o enqueue do outbox e o recordAudit são exercitados via um
 * `tx` mockado — sem I/O real. Cobrem:
 *  - execução sob o tenant da conta de serviço (Req. 16.1);
 *  - condição satisfeita → despacha ação via outbox + audita, na mesma
 *    transação (Req. 16.2);
 *  - falha de despacho → transação reverte (sem efeitos parciais) e a ação é
 *    enfileirada com política de retry ≤3 (Req. 16.3);
 *  - limite de 100 regras ativas por tenant na criação (Req. 16.4).
 *
 * _Requisitos: 16.1, 16.3, 16.4_
 */

import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_ACTION_TYPE,
  AUTOMATION_MAX_ACTIVE_RULES,
  AUTOMATION_MAX_ATTEMPTS,
  AutomationRuleLimitError,
  AutomationTenantMismatchError,
  conditionsMet,
  countActiveRules,
  createRule,
  evaluateCondition,
  runRule,
  type AutomationClient,
  type AutomationRule,
  type ServiceAccount,
} from "@/lib/automation/service";

const ACCOUNT: ServiceAccount = { id: "svc-1", companyId: "co-1" };

function makeRule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: "rule-1",
    companyId: "co-1",
    name: "Auto-atribuir urgentes",
    active: true,
    conditions: [{ field: "priority", equals: "CRITICAL" }],
    action: { kind: "ticket.assign", params: { toUserId: "u-9" } },
    ...over,
  };
}

/**
 * Client mockado cujo `$transaction(fn)` chama `fn(tx)` com um `tx` que expõe
 * `outboxEvent.create` e `auditLog.create`. Permite falhar o create do outbox.
 */
function mockClient(opts: {
  outboxCreate?: ReturnType<typeof vi.fn>;
  auditCreate?: ReturnType<typeof vi.fn>;
} = {}): {
  client: AutomationClient;
  outboxCreate: ReturnType<typeof vi.fn>;
  auditCreate: ReturnType<typeof vi.fn>;
} {
  const outboxCreate =
    opts.outboxCreate ?? vi.fn().mockResolvedValue({ id: "obx-1" });
  const auditCreate =
    opts.auditCreate ?? vi.fn().mockResolvedValue({ id: "aud-1" });
  const tx = {
    outboxEvent: { create: outboxCreate },
    auditLog: { create: auditCreate },
  };
  const client = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as AutomationClient;
  return { client, outboxCreate, auditCreate };
}

describe("AutomationService condition evaluation (puro)", () => {
  it("evaluateCondition compara igualdade estrita do campo", () => {
    expect(
      evaluateCondition({ field: "priority", equals: "HIGH" }, { priority: "HIGH" }),
    ).toBe(true);
    expect(
      evaluateCondition({ field: "priority", equals: "HIGH" }, { priority: "LOW" }),
    ).toBe(false);
  });

  it("equals null casa campo ausente ou nulo (fail-closed nos demais)", () => {
    expect(evaluateCondition({ field: "assignee", equals: null }, {})).toBe(true);
    expect(
      evaluateCondition({ field: "assignee", equals: null }, { assignee: null }),
    ).toBe(true);
    expect(
      evaluateCondition({ field: "assignee", equals: null }, { assignee: "x" }),
    ).toBe(false);
  });

  it("conditionsMet exige TODAS as condições (AND); vazio = sempre", () => {
    const rule = makeRule({
      conditions: [
        { field: "priority", equals: "CRITICAL" },
        { field: "channel", equals: "WHATSAPP" },
      ],
    });
    expect(conditionsMet(rule, { priority: "CRITICAL", channel: "WHATSAPP" })).toBe(
      true,
    );
    expect(conditionsMet(rule, { priority: "CRITICAL", channel: "EMAIL" })).toBe(
      false,
    );
    expect(conditionsMet(makeRule({ conditions: [] }), {})).toBe(true);
  });
});

describe("AutomationService.runRule (tenant + despacho + auditoria)", () => {
  it("executa sob o tenant da conta de serviço (Req. 16.1)", async () => {
    const { client, outboxCreate, auditCreate } = mockClient();

    const result = await runRule(client, ACCOUNT, makeRule(), {
      priority: "CRITICAL",
    });

    expect(result.dispatched).toBe(true);
    expect(result.outboxEventId).toBe("obx-1");
    // Outbox e auditoria usam o companyId da CONTA (não do fato/payload).
    expect(outboxCreate.mock.calls[0][0].data.companyId).toBe("co-1");
    expect(outboxCreate.mock.calls[0][0].data.type).toBe(AUTOMATION_ACTION_TYPE);
    expect(auditCreate.mock.calls[0][0].data.companyId).toBe("co-1");
    expect(auditCreate.mock.calls[0][0].data.action).toBe("automation.execute");
    // Política de retry ≤3 embarcada no payload do outbox.
    expect(outboxCreate.mock.calls[0][0].data.payload.maxAttempts).toBe(
      AUTOMATION_MAX_ATTEMPTS,
    );
  });

  it("não despacha quando a condição não é satisfeita (sem efeitos)", async () => {
    const { client, outboxCreate, auditCreate } = mockClient();

    const result = await runRule(client, ACCOUNT, makeRule(), {
      priority: "LOW",
    });

    expect(result.dispatched).toBe(false);
    expect(outboxCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("não despacha quando a regra está inativa", async () => {
    const { client, outboxCreate } = mockClient();
    const result = await runRule(
      client,
      ACCOUNT,
      makeRule({ active: false }),
      { priority: "CRITICAL" },
    );
    expect(result.dispatched).toBe(false);
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it("rejeita regra de outro tenant (AutomationTenantMismatchError)", async () => {
    const { client, outboxCreate } = mockClient();
    await expect(
      runRule(client, ACCOUNT, makeRule({ companyId: "co-OTHER" }), {
        priority: "CRITICAL",
      }),
    ).rejects.toBeInstanceOf(AutomationTenantMismatchError);
    expect(outboxCreate).not.toHaveBeenCalled();
  });
});

describe("AutomationService.runRule falha → sem efeitos parciais + retry (Req. 16.3)", () => {
  it("falha no despacho reverte a transação e não deixa efeito parcial", async () => {
    const boom = new Error("db down");
    // O create do outbox falha DENTRO da transação → tudo reverte.
    const outboxCreate = vi.fn().mockRejectedValue(boom);
    // A auditoria de execução nunca chega a rodar (transação abortou antes).
    const auditCreate = vi.fn().mockResolvedValue({ id: "aud-fail" });
    const { client } = mockClient({ outboxCreate, auditCreate });

    await expect(
      runRule(client, ACCOUNT, makeRule(), { priority: "CRITICAL" }),
    ).rejects.toBe(boom);

    // Auditoria de execução (sucesso) NÃO ocorre; só a de falha (best-effort).
    const executeAudits = auditCreate.mock.calls.filter(
      (c) => c[0].data.action === "automation.execute",
    );
    expect(executeAudits).toHaveLength(0);
    // Um audit de FALHA é gravado fora da transação revertida (Req. 16.3).
    const failedAudits = auditCreate.mock.calls.filter(
      (c) => c[0].data.action === "automation.execute.failed",
    );
    expect(failedAudits).toHaveLength(1);
    expect(failedAudits[0][0].data.companyId).toBe("co-1");
  });
});

describe("AutomationService limite de regras ativas (Req. 16.4)", () => {
  it("countActiveRules conta apenas ativas do tenant", () => {
    const rules = [
      makeRule({ id: "a", active: true }),
      makeRule({ id: "b", active: false }),
      makeRule({ id: "c", active: true, companyId: "co-2" }),
    ];
    expect(countActiveRules(rules, "co-1")).toBe(1);
  });

  it("createRule rejeita quando o tenant já está no limite de 100 ativas", () => {
    const existing: AutomationRule[] = Array.from(
      { length: AUTOMATION_MAX_ACTIVE_RULES },
      (_, i) => makeRule({ id: `r-${i}`, active: true }),
    );

    expect(() =>
      createRule(ACCOUNT, existing, makeRule({ id: "r-101", active: true })),
    ).toThrow(AutomationRuleLimitError);
  });

  it("createRule permite uma regra INATIVA mesmo no limite (não conta)", () => {
    const existing: AutomationRule[] = Array.from(
      { length: AUTOMATION_MAX_ACTIVE_RULES },
      (_, i) => makeRule({ id: `r-${i}`, active: true }),
    );

    const next = createRule(
      ACCOUNT,
      existing,
      makeRule({ id: "r-inactive", active: false }),
    );
    expect(next).toHaveLength(AUTOMATION_MAX_ACTIVE_RULES + 1);
  });

  it("createRule aceita nova regra ativa abaixo do limite", () => {
    const existing = [makeRule({ id: "a", active: true })];
    const next = createRule(ACCOUNT, existing, makeRule({ id: "b" }));
    expect(next).toHaveLength(2);
  });

  it("createRule rejeita regra de outro tenant", () => {
    expect(() =>
      createRule(ACCOUNT, [], makeRule({ companyId: "co-OTHER" })),
    ).toThrow(AutomationTenantMismatchError);
  });
});
