/**
 * Testes de IMUTABILIDADE do AuditService (Req. 13.2).
 *
 * A imutabilidade tem duas camadas (ver cabeçalho de `service.ts`):
 *  (1) guarda no cliente — a superfície do serviço NÃO expõe update/delete;
 *  (2) enforcement no banco — trigger/grant (documentado; teste DB opcional).
 *
 * Aqui validamos a camada (1):
 *  - `AuditService` não possui caminho de update/delete (asserção estrutural);
 *  - `rejectAuditMutation` LANÇA `AuditImmutabilityError` para update e delete;
 *  - `recordAudit` grava exatamente uma linha (append), e `listAudit` lê.
 *
 * _Requisitos: 13.2_
 */

import { describe, it, expect, vi } from "vitest";

import {
  AuditService,
  AuditImmutabilityError,
  recordAudit,
  listAudit,
  rejectAuditMutation,
  type AuditWriter,
  type AuditReader,
} from "@/lib/audit/service";

describe("AuditService — imutabilidade (Req. 13.2)", () => {
  it("o serviço NÃO expõe qualquer caminho de update/delete", () => {
    const keys = Object.keys(AuditService);
    // Superfície esperada: apenas append + read + guarda.
    expect(keys.sort()).toEqual(
      ["listAudit", "recordAudit", "rejectAuditMutation"].sort(),
    );

    // Nenhuma chave que sugira mutação da trilha.
    for (const k of keys) {
      expect(/update|delete|remove|destroy/i.test(k)).toBe(false);
    }
    // E de fato não há tais métodos.
    expect(
      (AuditService as Record<string, unknown>).updateAudit,
    ).toBeUndefined();
    expect(
      (AuditService as Record<string, unknown>).deleteAudit,
    ).toBeUndefined();
  });

  it("rejectAuditMutation lança AuditImmutabilityError para update e delete", () => {
    expect(() => rejectAuditMutation("update")).toThrow(AuditImmutabilityError);
    expect(() => rejectAuditMutation("delete")).toThrow(AuditImmutabilityError);
    try {
      rejectAuditMutation("delete");
    } catch (e) {
      expect(e).toBeInstanceOf(AuditImmutabilityError);
      expect((e as AuditImmutabilityError).code).toBe("AUDIT_IMMUTABLE");
    }
  });

  it("recordAudit grava EXATAMENTE um AuditLog (append-only)", async () => {
    const create = vi.fn((args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      return Promise.resolve({
        id: "a1",
        createdAt: new Date(),
        ...data,
      });
    });
    const writer = { auditLog: { create } } as unknown as AuditWriter;

    const rec = await recordAudit(writer, {
      companyId: "c1",
      actorId: "u1",
      action: "ticket.update",
      entityType: "ticket",
      entityId: "tk-1",
      before: { status: "OPEN" },
      after: { status: "CLOSED" },
      ip: "10.0.0.1",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(rec.id).toBe("a1");
    expect(rec.action).toBe("ticket.update");
  });

  it("listAudit lê escopado por tenant (append-only ⇒ só leitura)", async () => {
    const findMany = vi.fn(() =>
      Promise.resolve([
        {
          id: "a1",
          companyId: "c1",
          actorId: null,
          action: "x",
          entityType: "ticket",
          entityId: "tk-1",
          before: null,
          after: null,
          ip: null,
          createdAt: new Date(),
        },
      ]),
    );
    const reader = { auditLog: { findMany } } as unknown as AuditReader;

    const rows = await listAudit(reader, "c1", { entityType: "ticket" });
    expect(rows).toHaveLength(1);
    const arg = findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(arg.where.companyId).toBe("c1");
    expect(arg.where.entityType).toBe("ticket");
  });
});
