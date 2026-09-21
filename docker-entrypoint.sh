#!/usr/bin/env bash
#
# Entrypoint do serviço `app` — JÁ Helpdesk (tarefa 36.1).
#
# Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
# (seção "Implantação") e Requisito 18 (18.5, 18.6, 18.7, 18.8).
#
# Responsabilidades, NA ORDEM:
#   1. Validar que os segredos/variáveis OBRIGATÓRIOS existem e não estão vazios.
#      Se algum faltar, ABORTAR (exit != 0) e registrar QUAL falta — NUNCA o valor
#      (Req. 18.6). Opcionais ausentes só emitem aviso.
#   2. Aplicar migrações Prisma pendentes com `prisma migrate deploy` ANTES de
#      iniciar o servidor. Se a migração falhar, ABORTAR sem iniciar o app
#      (Req. 18.7, 18.8). `migrate deploy` é idempotente e transacional por
#      migração — não aplica migrações parciais.
#   3. `exec` no comando do servidor (CMD), substituindo o PID 1 para
#      encaminhamento correto de sinais (SIGTERM/SIGINT).
#
# `set -euo pipefail` garante fail-fast: qualquer comando com erro derruba o
# script antes de iniciar o app (nenhum start parcial).

set -euo pipefail

log() {
  # Log estruturado simples; a aplicação usa o logger JSON com redação.
  echo "[entrypoint] $*"
}

# ---------------------------------------------------------------------------
# 1) Validação de segredos/variáveis obrigatórios (Req. 18.6).
#    A lista espelha `validateRequiredSecrets` em src/lib/bootstrap/secrets.ts.
#    NUNCA imprima o VALOR de uma variável — apenas o NOME quando faltar.
# ---------------------------------------------------------------------------
REQUIRED_VARS=(
  "DATABASE_URL"
  "NEXTAUTH_SECRET"
  "NEXTAUTH_URL"
)

# Opcionais: se ausentes, apenas avisamos (recursos específicos ficam inativos).
OPTIONAL_VARS=(
  "REDIS_URL"
  "WHATSAPP_APP_SECRET"
  "WHATSAPP_VERIFY_TOKEN"
  "WHATSAPP_ACCESS_TOKEN"
  "WHATSAPP_PHONE_NUMBER_ID"
  "CHANNEL_WHATSAPP_PROVIDER"
  "RESEND_WEBHOOK_SECRET"
  "TURNSTILE_SECRET_KEY"
)

missing=()
for var in "${REQUIRED_VARS[@]}"; do
  # `-z` cobre tanto ausente quanto vazio (Req. 18.6: "ausente ou vazio").
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  log "ERRO: segredo(s)/variável(is) obrigatório(s) ausente(s) ou vazio(s): ${missing[*]}"
  log "Abortando inicialização sem iniciar o app (Req. 18.6). Nenhum valor de segredo é exibido."
  exit 1
fi

for var in "${OPTIONAL_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    log "AVISO: variável opcional ausente: ${var} (recurso associado ficará inativo)."
  fi
done

log "Validação de segredos concluída: todas as variáveis obrigatórias estão presentes."

# ---------------------------------------------------------------------------
# 2) Migrações Prisma (Req. 18.7, 18.8).
#    `migrate deploy` aplica apenas migrações pendentes já versionadas, de forma
#    idempotente. Se falhar, `set -e` derruba o script e o app NÃO inicia.
# ---------------------------------------------------------------------------
log "Aplicando migrações Prisma pendentes (prisma migrate deploy)…"
if ! npx --no-install prisma migrate deploy; then
  log "ERRO: falha ao aplicar migrações Prisma. Abortando sem iniciar o app (Req. 18.8)."
  log "O estado do banco é preservado — nenhuma migração parcial adicional é aplicada."
  exit 1
fi
log "Migrações aplicadas com sucesso."

# ---------------------------------------------------------------------------
# 3) Inicia o servidor (CMD). `exec` substitui o processo do shell para que os
#    sinais cheguem diretamente ao Node (shutdown limpo).
# ---------------------------------------------------------------------------
log "Iniciando o servidor: $*"
exec "$@"
