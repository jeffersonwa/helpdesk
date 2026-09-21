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
#   2. `exec` no comando do servidor (CMD), substituindo o PID 1 para
#      encaminhamento correto de sinais (SIGTERM/SIGINT).
#
# NOTA sobre migrações (Req. 18.7, 18.8): a imagem `runner` do app é o bundle
# standalone do Next e NÃO contém todas as dependências do Prisma CLI (ex.:
# `effect`, via `@prisma/config`). Por isso as migrações são aplicadas por um
# serviço dedicado `migrate` (imagem `worker`, com node_modules completo), que
# roda `prisma migrate deploy` ANTES de o app subir. O compose faz o `app`
# depender do `migrate` concluir com sucesso — mantendo a garantia de que o app
# só serve após as migrações (sem migração parcial).
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
# 2) Inicia o servidor (CMD). `exec` substitui o processo do shell para que os
#    sinais cheguem diretamente ao Node (shutdown limpo).
#    As migrações já foram aplicadas pelo serviço `migrate` (ver NOTA acima).
# ---------------------------------------------------------------------------
log "Iniciando o servidor: $*"
exec "$@"
