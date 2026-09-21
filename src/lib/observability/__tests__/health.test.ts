/**
 * Testes do health check (tarefa 30.4).
 *
 * Cobrem (Req. 19.3, 19.4) exercitando o NÚCLEO PURO `computeHealth` com probes
 * injetados (sem Next runtime, sem banco):
 *  - db/queue indisponível → geral `unhealthy` (HTTP 503);
 *  - todos ok → `healthy` em ≤2s;
 *  - probe lento → caminho de timeout resolve `unhealthy` (não trava).
 */

import { describe, it, expect } from "vitest";
import {
  computeHealth,
  healthHttpStatus,
  type Probe,
} from "@/lib/observability/health";

/** Probe que resolve com sucesso (saudável). */
const okProbe: Probe = async () => {};

/** Probe que lança (indisponível). */
const throwingProbe: Probe = async () => {
  throw new Error("connection refused");
};

/** Probe que resolve `false` (indisponível explícito). */
const falseProbe: Probe = async () => false;

describe("computeHealth — dependências críticas indisponíveis → unhealthy/503", () => {
  it("db indisponível (lança) → unhealthy + 503", async () => {
    const report = await computeHealth({
      dbProbe: throwingProbe,
      queueProbe: okProbe,
    });
    expect(report.status).toBe("unhealthy");
    expect(report.checks.db.status).toBe("unhealthy");
    expect(report.checks.queue.status).toBe("ok");
    expect(report.checks.app.status).toBe("ok");
    expect(healthHttpStatus(report.status)).toBe(503);
  });

  it("queue indisponível (resolve false) → unhealthy + 503", async () => {
    const report = await computeHealth({
      dbProbe: okProbe,
      queueProbe: falseProbe,
    });
    expect(report.status).toBe("unhealthy");
    expect(report.checks.queue.status).toBe("unhealthy");
    expect(report.checks.queue.detail).toBe("unavailable");
    expect(healthHttpStatus(report.status)).toBe(503);
  });

  it("db e queue indisponíveis → unhealthy + 503", async () => {
    const report = await computeHealth({
      dbProbe: throwingProbe,
      queueProbe: throwingProbe,
    });
    expect(report.status).toBe("unhealthy");
    expect(healthHttpStatus(report.status)).toBe(503);
  });
});

describe("computeHealth — tudo saudável → healthy em ≤2s", () => {
  it("todos os probes ok → healthy + 200, dentro de 2s", async () => {
    const start = Date.now();
    const report = await computeHealth({
      dbProbe: okProbe,
      queueProbe: okProbe,
    });
    const elapsed = Date.now() - start;

    expect(report.status).toBe("healthy");
    expect(report.checks.app.status).toBe("ok");
    expect(report.checks.db.status).toBe("ok");
    expect(report.checks.queue.status).toBe("ok");
    expect(healthHttpStatus(report.status)).toBe(200);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("computeHealth — probe lento não trava (timeout → unhealthy)", () => {
  it("um probe que nunca resolve dispara timeout e produz unhealthy, sem hang", async () => {
    // Probe que jamais resolve: sem timeout, isto travaria o health check.
    const hangingProbe: Probe = () => new Promise<void>(() => {});

    const start = Date.now();
    const report = await computeHealth({
      dbProbe: hangingProbe,
      queueProbe: okProbe,
      timeoutMs: 50, // timeout curto para o teste ser rápido
    });
    const elapsed = Date.now() - start;

    expect(report.checks.db.status).toBe("unhealthy");
    expect(report.checks.db.detail).toBe("timeout");
    expect(report.status).toBe("unhealthy");
    expect(healthHttpStatus(report.status)).toBe(503);
    // Não travou: completou logo após o timeout, bem abaixo de 2s.
    expect(elapsed).toBeLessThan(2000);
  });

  it("respeita o orçamento total ≤2s mesmo com ambos os probes lentos", async () => {
    const slowProbe: Probe = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 5_000));

    const start = Date.now();
    const report = await computeHealth({
      dbProbe: slowProbe,
      queueProbe: slowProbe,
      timeoutMs: 100,
    });
    const elapsed = Date.now() - start;

    expect(report.status).toBe("unhealthy");
    expect(report.checks.db.detail).toBe("timeout");
    expect(report.checks.queue.detail).toBe("timeout");
    expect(elapsed).toBeLessThan(2000);
  });
});
