/**
 * Property 11 — Não vazamento de segredos (tarefa 30.3).
 *
 * **Property 11: Não vazamento de segredos**
 * **Validates: Requisitos 19.2, 18.5**
 *
 * Para TODA chamada de log com campos arbitrários, INCLUINDO chaves/valores de
 * aparência sensível, a saída emitida NUNCA contém o VALOR do segredo — apenas
 * `[REDACTED]`. O logger é síncrono, então usamos `fc.property` (sem `await`).
 *
 * Estratégia:
 *  - `fc` gera um objeto de `fields` misturando chaves sensíveis (com valores
 *    aleatórios que servem de "segredo") e chaves benignas.
 *  - Injetamos um `sink` que captura as linhas emitidas (equivalente a espiar o
 *    console, mas determinístico).
 *  - Asseveramos que nenhum VALOR associado a uma chave sensível aparece na
 *    linha JSON, e que `[REDACTED]` está presente quando havia chave sensível.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createLogger,
  isSensitiveKey,
  REDACTED,
  type LogSink,
} from "@/lib/observability/logger";

/** Nomes de chave reconhecidamente sensíveis (o logger deve redigi-los). */
const SENSITIVE_KEYS = [
  "token",
  "password",
  "secret",
  "authorization",
  "accessToken",
  "appSecret",
  "apiKey",
  "verifyToken",
  "privateKey",
  "clientSecret",
  "refreshToken",
  "X-Api-Key",
  "db_password",
];

/** Chaves benignas que NÃO devem ser redigidas. */
const BENIGN_KEYS = ["companyId", "requestId", "channel", "count", "url", "secretRef"];

/** Valor de "segredo" aleatório mas não-vazio e distinguível. */
const secretValueArb = fc
  .string({ minLength: 6, maxLength: 40 })
  .map((s) => `SECRET_${s.replace(/\s/g, "_")}_END`);

describe("Property 11 — o logger nunca emite valores de segredo", () => {
  it("valores de chaves sensíveis nunca aparecem na saída (apenas [REDACTED])", () => {
    fc.assert(
      fc.property(
        // Um ou mais campos sensíveis com valores-segredo.
        fc.dictionary(fc.constantFrom(...SENSITIVE_KEYS), secretValueArb, {
          minKeys: 1,
        }),
        // Campos benignos arbitrários.
        fc.dictionary(
          fc.constantFrom(...BENIGN_KEYS),
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        ),
        fc.constantFrom("debug", "info", "warn", "error") as fc.Arbitrary<
          "debug" | "info" | "warn" | "error"
        >,
        (sensitiveFields, benignFields, level) => {
          const lines: string[] = [];
          const sink: LogSink = {
            debug: (l) => lines.push(l),
            info: (l) => lines.push(l),
            warn: (l) => lines.push(l),
            error: (l) => lines.push(l),
          };
          const logger = createLogger({ sink, now: () => new Date(0) });

          logger[level]("evento", { ...benignFields, ...sensitiveFields });

          expect(lines).toHaveLength(1);
          const line = lines[0];

          // Nenhum valor-segredo aparece na linha emitida.
          for (const value of Object.values(sensitiveFields)) {
            expect(line).not.toContain(value);
          }
          // Como havia ao menos uma chave sensível, [REDACTED] está presente.
          expect(line).toContain(REDACTED);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("segredos em estruturas ANINHADAS também são redigidos", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SENSITIVE_KEYS),
        secretValueArb,
        (key, value) => {
          const lines: string[] = [];
          const sink: LogSink = {
            debug: (l) => lines.push(l),
            info: (l) => lines.push(l),
            warn: (l) => lines.push(l),
            error: (l) => lines.push(l),
          };
          const logger = createLogger({ sink, now: () => new Date(0) });

          logger.info("aninhado", {
            outer: { inner: { [key]: value }, list: [{ [key]: value }] },
          });

          const line = lines[0];
          expect(line).not.toContain(value);
          expect(line).toContain(REDACTED);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("`secretRef` (referência, não valor) é preservado", () => {
    // Sanidade: secretRef não é redigido (é uma referência opaca, não o segredo).
    expect(isSensitiveKey("secretRef")).toBe(false);

    const lines: string[] = [];
    const sink: LogSink = {
      debug: (l) => lines.push(l),
      info: (l) => lines.push(l),
      warn: (l) => lines.push(l),
      error: (l) => lines.push(l),
    };
    const logger = createLogger({ sink, now: () => new Date(0) });
    logger.info("ref", { secretRef: "whatsapp:default" });
    expect(lines[0]).toContain("whatsapp:default");
  });
});
