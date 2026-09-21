/**
 * Testes de validação de bootstrap (tarefa 36.2).
 *
 * Cobrem (Req. 18.6, 18.8):
 *  - segredo obrigatório ausente/vazio → `ok: false` e o NOME em `missing`;
 *  - todas presentes → `ok: true` e `missing` vazio;
 *  - o `missing` nunca contém VALORES de segredo (apenas nomes) — Property 11;
 *  - o `docker-entrypoint.sh` faz fail-fast do start (`set -euo pipefail`,
 *    `exit 1` na falta de segredo) ANTES do `exec` (Req. 18.6);
 *  - as migrações rodam num serviço `migrate` dedicado no
 *    `docker-compose.prod.yml`, e o `app` só sobe após ele concluir com
 *    sucesso — sem migração parcial (Req. 18.7, 18.8).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  validateRequiredSecrets,
  DEFAULT_REQUIRED_SECRET_KEYS,
  type EnvMap,
} from "@/lib/bootstrap/secrets";

describe("validateRequiredSecrets — segredo obrigatório ausente (Req. 18.6)", () => {
  it("retorna ok:false e nomeia a chave ausente", () => {
    const env: EnvMap = {
      DATABASE_URL: "postgresql://u:p@h:5432/db",
      NEXTAUTH_URL: "https://csc.nitecnologia.tec.br",
      // NEXTAUTH_SECRET ausente.
    };
    const result = validateRequiredSecrets(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("NEXTAUTH_SECRET");
  });

  it("trata string vazia e só-espaços como ausente", () => {
    const env: EnvMap = {
      DATABASE_URL: "",
      NEXTAUTH_SECRET: "   ",
      NEXTAUTH_URL: "https://csc.nitecnologia.tec.br",
    };
    const result = validateRequiredSecrets(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining(["DATABASE_URL", "NEXTAUTH_SECRET"]),
    );
    expect(result.missing).not.toContain("NEXTAUTH_URL");
  });

  it("lista TODAS as chaves obrigatórias quando o ambiente está vazio", () => {
    const result = validateRequiredSecrets({});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([...DEFAULT_REQUIRED_SECRET_KEYS]);
  });

  it("respeita uma lista customizada de chaves obrigatórias", () => {
    const env: EnvMap = { FOO: "x" };
    const result = validateRequiredSecrets(env, ["FOO", "BAR"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["BAR"]);
  });
});

describe("validateRequiredSecrets — todas presentes (Req. 18.6)", () => {
  it("retorna ok:true e missing vazio", () => {
    const env: EnvMap = {
      DATABASE_URL: "postgresql://u:p@h:5432/db",
      NEXTAUTH_SECRET: "a-strong-random-secret",
      NEXTAUTH_URL: "https://csc.nitecnologia.tec.br",
    };
    const result = validateRequiredSecrets(env);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

describe("validateRequiredSecrets — não vazamento de segredos (Property 11 / Req. 18.5)", () => {
  it("missing contém apenas NOMES de chave, nunca VALORES", () => {
    const secretValue = "super-secret-token-value";
    const env: EnvMap = {
      DATABASE_URL: secretValue, // presente, então NÃO deve aparecer em missing
      // NEXTAUTH_SECRET e NEXTAUTH_URL ausentes
    };
    const result = validateRequiredSecrets(env);
    // O valor presente nunca vaza; apenas os nomes das ausentes são reportados.
    expect(result.missing).not.toContain(secretValue);
    expect(result.missing).toEqual(
      expect.arrayContaining(["NEXTAUTH_SECRET", "NEXTAUTH_URL"]),
    );
  });

  it("é pura: não muta a entrada e é determinística", () => {
    const env: EnvMap = { DATABASE_URL: "x" };
    const snapshot = JSON.stringify(env);
    const a = validateRequiredSecrets(env);
    const b = validateRequiredSecrets(env);
    expect(JSON.stringify(env)).toBe(snapshot); // não mutou
    expect(a).toEqual(b); // determinística
  });
});

describe("docker-entrypoint.sh — fail-fast de start (Req. 18.6)", () => {
  const script = readFileSync(
    resolve(process.cwd(), "docker-entrypoint.sh"),
    "utf8",
  );

  it("usa `set -euo pipefail` (fail-fast; nenhum start parcial)", () => {
    expect(script).toContain("set -euo pipefail");
  });

  it("aborta (exit 1) quando falta segredo obrigatório", () => {
    expect(script).toMatch(/missing/);
    expect(script).toMatch(/exit 1/);
  });

  it("valida os segredos ANTES de fazer `exec` no CMD", () => {
    // O bloco de validação de obrigatórios precede o start do servidor.
    const missingIdx = script.indexOf("missing");
    const execIdx = script.indexOf('exec "$@"');
    expect(missingIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(missingIdx);
  });
});

describe("docker-compose.prod.yml — migração via serviço dedicado (Req. 18.7, 18.8)", () => {
  // As migrações NÃO rodam no entrypoint do app (o bundle standalone do Next
  // não tem as deps do Prisma CLI). Rodam num serviço `migrate` com a imagem
  // `worker` (node_modules completo), e o `app` só sobe após ele concluir com
  // sucesso — garantindo que o app nunca serve com schema desatualizado.
  const compose = readFileSync(
    resolve(process.cwd(), "docker-compose.prod.yml"),
    "utf8",
  );

  it("define um serviço `migrate` que roda `migrate deploy`", () => {
    expect(compose).toMatch(/migrate:/);
    expect(compose).toContain("migrate");
    expect(compose).toContain("deploy");
  });

  it("faz `app` depender do `migrate` concluir com sucesso (sem migração parcial)", () => {
    expect(compose).toMatch(/service_completed_successfully/);
  });
});
