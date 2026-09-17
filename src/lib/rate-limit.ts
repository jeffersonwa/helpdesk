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
