#!/usr/bin/env bash
# Deploy DIRETO na máquina (build local no servidor), sem CI/CD.
# Idempotente. Builda as imagens app+worker com a tag "local" que o
# docker-compose.prod.yml consome (via IMAGE_TAG), e sobe a stack reusando o
# Traefik existente (rede externa proxy_network).
set -euo pipefail

DIR=/opt/helpdesk
cd "$DIR"

echo "[deploy] Extraindo código-fonte…"
rm -rf build-src
mkdir -p build-src
tar -xzf helpdesk-src.tar.gz -C build-src

echo "[deploy] Normalizando line endings do entrypoint…"
sed -i 's/\r$//' build-src/docker-entrypoint.sh || true

IMG=ghcr.io/jeffersonwa/helpdesk

echo "[deploy] Buildando imagem do app (target runner)…"
docker build -t "${IMG}-app:local" --target runner build-src

echo "[deploy] Buildando imagem do worker (target worker)…"
docker build -t "${IMG}-worker:local" --target worker build-src

echo "[deploy] Subindo a stack (migrate → app → worker)…"
export IMAGE_TAG=local
docker compose -f docker-compose.prod.yml up -d --remove-orphans

echo "[deploy] Estado dos serviços:"
docker compose -f docker-compose.prod.yml ps
