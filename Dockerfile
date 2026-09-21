# syntax=docker/dockerfile:1
#
# Dockerfile de produção — JÁ Helpdesk (tarefa 36.1).
#
# Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
# (seção "Implantação" → Docker Compose) e Requisito 18 (18.1..18.8).
#
# Estratégia multi-stage:
#   base    → imagem Node comum (alpine, com libc compat p/ Prisma engines).
#   deps    → instala TODAS as dependências (dev incluídas) para o build.
#   builder → `prisma generate` + `next build` (produz .next/standalone).
#   runner  → imagem final ENXUTA do serviço `app` (standalone, non-root).
#   worker  → imagem do serviço `worker` (source TS + tsx + prod deps + prisma CLI).
#
# Segurança (Req. 18.5): NENHUM segredo é copiado para a imagem. Segredos chegam
# somente em runtime via variáveis de ambiente (`.env`, secret manager, K8s Secret).
# NÃO faça `COPY .env` — o `.dockerignore` também o exclui.
#
# O serviço `app` roda como usuário non-root e usa o entrypoint
# `docker-entrypoint.sh`, que valida segredos obrigatórios e aplica migrações
# Prisma pendentes ANTES de iniciar o servidor (Req. 18.6, 18.7, 18.8).

# ---------------------------------------------------------------------------
# base — Node 22 LTS sobre Alpine. `libc6-compat` é necessário para os engines
# nativos do Prisma em Alpine.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — instala dependências reprodutíveis a partir do lockfile.
# (inclui devDependencies porque o build precisa do Prisma CLI, tsx, next etc.)
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# builder — gera o Prisma Client e compila o Next em modo standalone.
# `npm run build` = "prisma generate && next build" (definido em package.json).
# ---------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Evita telemetria do Next durante o build.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------------------------------------------------------------------------
# runner — imagem final do serviço `app`. Copia apenas o necessário do
# standalone + assets estáticos + public + prisma (schema/migrations e o CLI
# para `prisma migrate deploy` no entrypoint).
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Usuário non-root dedicado.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Ferramentas de runtime do entrypoint: bash (script) e o Prisma CLI para
# `prisma migrate deploy`. Instalamos apenas prisma + o adapter/driver no runner.
RUN apk add --no-cache bash

# Artefatos do standalone (inclui um node_modules mínimo do próprio Next).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma: schema + migrations + config, para aplicar migrações no start.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

# O Prisma CLI (e o Prisma Client já gerado) vêm do builder. Copiamos o pacote
# `prisma` e `@prisma` (client + engines) para permitir `migrate deploy`.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

# Entrypoint (validação de segredos + migrações + exec do servidor).
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nextjs
EXPOSE 3000

# O entrypoint faz fail-fast de segredos e migrações; o CMD é o servidor Next
# standalone (server.js na raiz do standalone).
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
# worker — serviço de jobs (outbox + escalonamento). O worker é TypeScript em
# `src/worker/index.ts` e NÃO faz parte do bundle standalone do Next. Mecanismo
# escolhido: rodar direto do fonte com `tsx` (loader de TS para Node), via o
# script npm `worker` (`node --import tsx src/worker/index.ts`).
#
# Esta imagem mantém node_modules (com tsx + prisma) e o código-fonte. Roda como
# non-root. O worker não expõe portas.
# ---------------------------------------------------------------------------
FROM base AS worker
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nodejs-worker || true

# node_modules completo (inclui tsx e o Prisma Client já gerado) + fonte.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/src ./src

# O worker roda o script npm. As migrações são responsabilidade do `app`
# (Req. 18.7): o worker apenas consome o schema já migrado.
CMD ["npm", "run", "worker"]
