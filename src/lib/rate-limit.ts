// Rate limiter simples em memória (janela deslizante por chave).
// Adequado para deploy em processo único (container próprio); em ambiente
// serverless multi-instância isso precisaria de um store compartilhado
// (Redis/Upstash) para ser efetivo.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Limpeza periódica para não vazar memória com chaves antigas
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

/**
 * Retorna true se a requisição está dentro do limite permitido.
 * @param key identificador único (ex: `login:<ip>` ou `login:<email>`)
 * @param limit número máximo de tentativas na janela
 * @param windowMs duração da janela em milissegundos
 */
export function rateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count };
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

// ---------------------------------------------------------------------------
// Rate limiter INJETÁVEL (token-bucket por janela fixa) — testável.
//
// O `rateLimit` acima usa um relógio/`Map` globais e é adequado para uso
// direto em route handlers de processo único. Para camadas testáveis (ex.:
// `PublicFormAdapter`, Req 8.1/8.2) precisamos de um limitador com:
//   - relógio injetável (`now`), para testar janelas sem `sleep`;
//   - store plugável (`RateLimitStore`), para trocar memória por Redis/etc.
//
// A semântica é a mesma janela fixa: a primeira requisição de uma chave abre
// uma janela de `windowMs`; requisições subsequentes dentro dela incrementam
// o contador até `limit`; ao exceder, `allowed=false`. Passada a janela, o
// contador reinicia.
// ---------------------------------------------------------------------------

/** Estado de uma janela para uma chave. */
export interface RateLimitBucket {
  count: number;
  resetAt: number;
}

/**
 * Store plugável do limitador injetável. Uma implementação em memória é
 * fornecida por `createMemoryRateLimitStore`; produção pode fornecer Redis.
 */
export interface RateLimitStore {
  get(key: string): RateLimitBucket | undefined;
  set(key: string, bucket: RateLimitBucket): void;
}

/** Resultado de uma checagem de limite. */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

/** Store em memória para o limitador injetável (sem timers globais). */
export function createMemoryRateLimitStore(): RateLimitStore {
  const map = new Map<string, RateLimitBucket>();
  return {
    get: (key) => map.get(key),
    set: (key, bucket) => {
      map.set(key, bucket);
    },
  };
}

export interface InjectableRateLimiterDeps {
  /** Store de janelas. Padrão: memória. */
  store?: RateLimitStore;
  /** Relógio em ms. Padrão: `Date.now`. */
  now?: () => number;
}

/** Limitador de janela fixa com relógio e store injetáveis. */
export interface InjectableRateLimiter {
  /**
   * Consome uma unidade para `key`. Retorna `allowed=false` quando o limite
   * da janela atual foi excedido (nesse caso, o contador NÃO é incrementado).
   */
  check(key: string, limit: number, windowMs: number): RateLimitResult;
}

export function createRateLimiter(
  deps: InjectableRateLimiterDeps = {},
): InjectableRateLimiter {
  const store = deps.store ?? createMemoryRateLimitStore();
  const now = deps.now ?? (() => Date.now());

  return {
    check(key, limit, windowMs) {
      const t = now();
      const bucket = store.get(key);

      if (!bucket || bucket.resetAt <= t) {
        store.set(key, { count: 1, resetAt: t + windowMs });
        return { allowed: true, remaining: limit - 1 };
      }

      if (bucket.count >= limit) {
        return { allowed: false, remaining: 0 };
      }

      bucket.count += 1;
      store.set(key, bucket);
      return { allowed: true, remaining: limit - bucket.count };
    },
  };
}
