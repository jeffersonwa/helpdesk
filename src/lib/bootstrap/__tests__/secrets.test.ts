/**
 * Testes de validação de bootstrap (tarefa 36.2).
 *
 * Cobrem (Req. 18.6, 18.8):
 *  - segredo obrigatório ausente/vazio → `ok: false` e o NOME em `missing`;
 *  - todas presentes → `ok: true` e `missing` vazio;
 *  - o `missing` nunca contém VALORES de segredo (apenas nomes) — Property 11;
 *  - o `docker-entrypoint.sh` contém a lógica de fail-fast que HALTA o start sem
 *    aplicar migrações parciais (Req. 18.8): `set -euo pipefail`, `exit 1` na
 *    falha de segredo e na falha de `prisma migrate deploy`.
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

describe("docker-entrypoint.sh — fail-fast de start e migração (Req. 18.8)", () => {
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

  it("aplica migrações com `prisma migrate deploy` ANTES de iniciar o app", () => {
    expect(script).toContain("prisma migrate deploy");
  });

  it("aborta sem iniciar o app se a migração falhar (Req. 18.8)", () => {
    // Bloco `if ! ... migrate deploy; then ... exit 1`.
    expect(script).toMatch(/if\s+!\s+npx[^\n]*prisma migrate deploy/);
  });

  it("faz `exec` no CMD apenas após validação e migração", () => {
    const migrateIdx = script.indexOf("prisma migrate deploy");
    const execIdx = script.indexOf('exec "$@"');
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(migrateIdx);
  });
});
