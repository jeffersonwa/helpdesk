/**
 * Validação de segredos/variáveis obrigatórios na inicialização (tarefa 36.2).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Implantação") e Requisito 18 (18.6, 18.8).
 *
 * ------------------------------------------------------------------------
 * CONTRATO (Req. 18.6)
 * ------------------------------------------------------------------------
 * `validateRequiredSecrets(env, requiredKeys)` é uma função PURA (sem I/O, sem
 * `process.env`, sem logs) que recebe um mapa de ambiente e a lista de chaves
 * obrigatórias, e responde:
 *   - `{ ok: true,  missing: [] }`            quando todas presentes e não vazias;
 *   - `{ ok: false, missing: [...nomes] }`    listando exatamente as que faltam.
 *
 * Uma chave é considerada AUSENTE quando não existe, é `undefined`/`null`, ou é
 * uma string vazia / só de espaços (Req. 18.6: "ausente ou vazio"). O resultado
 * expõe apenas os NOMES das chaves faltantes — NUNCA valores (Property 11 /
 * Req. 18.5). Conceitualmente, é a mesma verificação que o `docker-entrypoint.sh`
 * executa antes de aplicar migrações e iniciar o servidor: se `ok` for `false`,
 * o start é abortado com fail-fast (o entrypoint usa `set -euo pipefail` +
 * `exit 1`), e a falha de migração (Req. 18.8) é enforçada por `prisma migrate
 * deploy` (idempotente, transacional por migração) sob o mesmo fail-fast.
 */

/** Chaves de ambiente OBRIGATÓRIAS por padrão para o serviço `app`. */
export const DEFAULT_REQUIRED_SECRET_KEYS: readonly string[] = [
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
];

/** Mapa de ambiente: valores possivelmente ausentes. */
export type EnvMap = Record<string, string | undefined>;

/** Resultado da validação. `missing` nunca contém valores, apenas nomes. */
export interface SecretValidationResult {
  ok: boolean;
  missing: string[];
}

/**
 * Considera um valor "presente" quando é uma string com pelo menos um caractere
 * não-branco. `undefined`/`null`/`""`/`"   "` são todos ausentes (Req. 18.6).
 */
function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Valida que todas as `requiredKeys` estão presentes e não vazias em `env`.
 * Função PURA e determinística: mesma entrada → mesma saída, sem efeitos.
 *
 * @param env          Mapa de ambiente (ex.: `process.env` na borda).
 * @param requiredKeys Chaves obrigatórias (default: {@link DEFAULT_REQUIRED_SECRET_KEYS}).
 * @returns `{ ok, missing }` — `ok` sse `missing` estiver vazio.
 */
export function validateRequiredSecrets(
  env: EnvMap,
  requiredKeys: readonly string[] = DEFAULT_REQUIRED_SECRET_KEYS,
): SecretValidationResult {
  const missing: string[] = [];
  for (const key of requiredKeys) {
    if (!isPresent(env[key])) {
      missing.push(key);
    }
  }
  return { ok: missing.length === 0, missing };
}
