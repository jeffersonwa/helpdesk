/**
 * Logger estruturado com mascaramento de segredos/PII (tarefa 30.1).
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Observabilidade") e requirements 19.1, 19.2.
 *
 * ------------------------------------------------------------------------
 * FORMA DO LOG (Req. 19.1)
 * ------------------------------------------------------------------------
 * Cada evento é emitido como UMA linha JSON em `console` contendo, no mínimo,
 * `level`, `timestamp` (ISO-8601) e `msg`. Campos de contexto opcionais
 * (`companyId`, `requestId`, `channel`) e quaisquer `fields` adicionais são
 * mesclados no mesmo objeto.
 *
 * ------------------------------------------------------------------------
 * NÃO VAZAMENTO DE SEGREDOS (Req. 19.2, Correctness Property 11)
 * ------------------------------------------------------------------------
 * Antes de serializar, o objeto inteiro é percorrido recursivamente e QUALQUER
 * chave cujo nome sugira um segredo (token, senha, chave, autorização, etc.) tem
 * seu VALOR substituído por `"[REDACTED]"`. Assim, o valor do segredo nunca é
 * impresso — apenas a referência (`secretRef`, que NÃO é um segredo, é
 * preservada por ser uma referência opaca, conforme o design).
 *
 * A detecção é por NOME de chave (case-insensitive, ignorando separadores como
 * `_`/`-`), cobrindo formas comuns: `token`, `password`, `secret`,
 * `authorization`, `accessToken`, `appSecret`, `apiKey`, `verifyToken`,
 * `privateKey`, `clientSecret`, `refreshToken`, etc. `secretRef` é
 * explicitamente permitido (é uma referência, não o valor).
 *
 * Dependência-zero: usa apenas `console` e JSON nativos.
 */

/** Níveis de severidade suportados. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Marcador impresso no lugar de valores sensíveis. */
export const REDACTED = "[REDACTED]" as const;

/** Campos de contexto padronizados (Req. 19.1). */
export interface LogContext {
  companyId?: string;
  requestId?: string;
  channel?: string;
}

/** Campos arbitrários adicionais anexados ao log. */
export type LogFields = Record<string, unknown>;

/**
 * Chaves permitidas mesmo contendo substrings sensíveis, por serem REFERÊNCIAS
 * (não valores de segredo). Normalizadas (minúsculas, sem separadores).
 */
const ALLOWLIST = new Set<string>(["secretref"]);

/**
 * Fragmentos que, presentes no nome normalizado da chave, indicam um valor
 * sensível. A verificação é por substring para cobrir variações
 * (`accessToken`, `x-api-key`, `db_password`, ...).
 */
const SENSITIVE_FRAGMENTS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "apikey",
  "accesskey",
  "privatekey",
  "credential",
  "signature",
  "hmac",
  "bearer",
  "sessionid",
  "cookie",
];

/** Normaliza o nome de uma chave: minúsculas, sem `_`, `-`, espaços. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

/**
 * Decide se o VALOR de uma chave deve ser redigido. `secretRef` (e variações
 * normalizadas na allowlist) é preservado; qualquer chave cujo nome contenha um
 * fragmento sensível é redigida.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (ALLOWLIST.has(normalized)) return false;
  return SENSITIVE_FRAGMENTS.some((frag) => normalized.includes(frag));
}

/**
 * Percorre recursivamente `value`, redigindo valores de chaves sensíveis.
 * Retorna uma CÓPIA segura (não muta a entrada). Protege contra referências
 * circulares via um `WeakSet` de objetos já visitados.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value as object)) {
    return "[Circular]";
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  // Erros: preserva mensagem/nome (assumidos livres de segredos por construção
  // no domínio), mas não expõe propriedades arbitrárias sensíveis.
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(val, seen);
  }
  return out;
}

/** Escritor de saída injetável (default: `console`). Facilita testes. */
export interface LogSink {
  debug(line: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

const consoleSink: LogSink = {
  debug: (line) => console.debug(line),
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/** Opções de construção do logger. */
export interface LoggerOptions {
  /** Contexto fixo aplicado a todos os eventos (ex.: `requestId`). */
  context?: LogContext;
  /** Relógio injetável (default: `Date`). */
  now?: () => Date;
  /** Destino de saída (default: `console`). */
  sink?: LogSink;
}

/** Interface pública do logger. */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Deriva um logger com contexto adicional mesclado. */
  child(context: LogContext): Logger;
}

/**
 * Constrói um {@link Logger}. Cada chamada monta o objeto de log, REDIGE valores
 * sensíveis e emite uma linha JSON no sink. `context` é mesclado em todo evento.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const baseContext = options.context ?? {};
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? consoleSink;

  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    // Monta o registro: nível/timestamp/msg + contexto + campos.
    const record: Record<string, unknown> = {
      level,
      timestamp: now().toISOString(),
      msg,
      ...baseContext,
      ...(fields ?? {}),
    };
    // Redige o registro INTEIRO (inclui contexto e campos aninhados).
    const safe = redact(record) as Record<string, unknown>;
    const line = JSON.stringify(safe);
    sink[level](line);
  }

  const logger: Logger = {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (context) =>
      createLogger({
        context: { ...baseContext, ...context },
        now,
        sink,
      }),
  };
  return logger;
}

/** Logger padrão do processo (contexto vazio, sink de console). */
export const logger: Logger = createLogger();
