#!/usr/bin/env bash
# Setup one-time do /opt/helpdesk no servidor de produção.
# Idempotente: gera .env com segredos fortes SOMENTE se ainda não existir;
# nunca sobrescreve segredos já em uso.
set -euo pipefail

DIR=/opt/helpdesk
sudo mkdir -p "$DIR"
sudo chown "$USER":"$USER" "$DIR"
cd "$DIR"

# Instala o compose de produção (enviado para /tmp), normalizando line endings.
if [[ -f /tmp/docker-compose.prod.yml ]]; then
  sed 's/\r$//' /tmp/docker-compose.prod.yml > "$DIR/docker-compose.prod.yml"
  echo "COMPOSE_INSTALADO_OK"
fi

if [[ -f .env ]]; then
  echo "ENV_JA_EXISTE: preservando .env atual (segredos intactos)."
else
  NEXTAUTH_SECRET="$(openssl rand -base64 32)"
  POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)"
  cat > .env <<EOF
# .env de PRODUÇÃO — JÁ Helpdesk. Gerado pelo setup one-time.
# git-ignored / fora do repositório. NUNCA commitar.

# Núcleo
DATABASE_URL="postgresql://helpdesk:${POSTGRES_PASSWORD}@postgres:5432/helpdesk?schema=public"
NEXTAUTH_URL="https://csc.nitecnologia.tec.br"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET}"

# Redis
REDIS_URL="redis://redis:6379"

# Postgres (serviço do compose)
POSTGRES_USER="helpdesk"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD}"
POSTGRES_DB="helpdesk"

# WhatsApp (Meta Cloud API oficial) — preencher quando as credenciais existirem.
# Enquanto vazias, o canal WhatsApp fica inativo (a app ainda inicia).
CHANNEL_WHATSAPP_PROVIDER="whatsapp_cloud"
WHATSAPP_APP_SECRET=""
WHATSAPP_VERIFY_TOKEN=""
WHATSAPP_ACCESS_TOKEN=""
WHATSAPP_PHONE_NUMBER_ID=""

# E-mail / formulário público (opcionais)
RESEND_WEBHOOK_SECRET=""
TURNSTILE_SECRET_KEY=""
EOF
  chmod 600 .env
  echo "ENV_CRIADO_OK"
fi

echo "DIR_CONTEUDO:"
ls -la "$DIR"
