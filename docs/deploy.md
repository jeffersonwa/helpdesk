# Deploy & CI/CD — JÁ Helpdesk

Publicação **sempre via CI/CD** (GitHub Actions). Não há deploy manual: todo
código chega em produção passando por `CI` (lint + typecheck + testes + build)
e, na branch `main`, pelo `Deploy` automático.

Domínio de produção: **https://csc.nitecnologia.tec.br** · Servidor: `148.113.236.231`.

## Fluxo

```
push/PR  ──►  CI (ci.yml)  ──►  [main only]  Deploy (deploy.yml)
              lint                            build imagem app+worker
              typecheck                       push GHCR
              test (unit+integração)          ssh servidor
              build                           docker compose pull + up -d
```

- `CI` sobe um Postgres efêmero e roda a suíte inteira (os testes de integração
  se auto-pulam quando não há `DATABASE_URL`; no CI ela é fornecida).
- `Deploy` só dispara via `workflow_run` **após o CI concluir com sucesso** em
  `main`. Build isolado no runner; o servidor apenas faz `pull` + `up`.

## Imagens (GHCR)

- `ghcr.io/<owner>/<repo>-app` — serviço web (target `runner` do Dockerfile).
- `ghcr.io/<owner>/<repo>-worker` — jobs de outbox/escalonamento (target `worker`).

Tags: `latest` e o `:${{ github.sha }}` de cada commit (rollback = subir uma sha
anterior via `IMAGE_TAG`).

## Secrets do repositório (Settings → Secrets and variables → Actions)

| Secret | Descrição |
| --- | --- |
| `SSH_HOST` | `148.113.236.231` |
| `SSH_USER` | `rocky` |
| `SSH_PRIVATE_KEY` | Chave **privada dedicada ao deploy** (não reutilizar chaves pessoais) |
| `SSH_PORT` | (opcional) porta SSH; default `22` |
| `DEPLOY_DIR` | Diretório do compose no servidor, ex. `/opt/helpdesk` |

`GITHUB_TOKEN` (automático) cobre o push no GHCR — sem secret extra.

### Chave de deploy dedicada

Gerar um par exclusivo para o Actions e autorizar a pública no servidor:

```bash
ssh-keygen -t ed25519 -C "gha-deploy-helpdesk" -f gha_deploy -N ""
# conteúdo de gha_deploy      → secret SSH_PRIVATE_KEY
# conteúdo de gha_deploy.pub  → append em ~/.ssh/authorized_keys do usuário no servidor
```

> A chave RSA que foi exposta em chat deve ser **revogada/rotacionada** e nunca
> usada aqui.

## Setup one-time no servidor

1. Docker + plugin compose instalados.
2. Criar `$DEPLOY_DIR` (ex. `/opt/helpdesk`) com:
   - `docker-compose.prod.yml` (deste repositório);
   - `.env` de produção (fora do git) a partir de `.env.example`, com os
     segredos reais (`NEXTAUTH_SECRET`, `POSTGRES_PASSWORD`, tokens WhatsApp…).
3. Definir o proxy/TLS (abaixo).

O `.env` de produção precisa ao menos de: `DATABASE_URL`, `NEXTAUTH_SECRET`,
`NEXTAUTH_URL=https://csc.nitecnologia.tec.br`, `POSTGRES_USER/PASSWORD/DB`.
Gerar segredos:

```bash
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD
```

## Proxy reverso / TLS

O servidor `148.113.236.231` já roda um **Traefik central** (container `traefik`)
nas portas 80/443, servindo vários sistemas de clientes. Reusamos esse proxy —
**não** subimos outro. O `app` entra na rede externa **`proxy_network`** (a do
Traefik) e é roteado por labels (já configuradas em `docker-compose.prod.yml`):

- entrypoint `websecure` (:443), TLS via certresolver `letsencrypt`;
- o Traefik existente já redireciona HTTP→HTTPS globalmente;
- `traefik.http.services.helpdesk.loadbalancer.server.port=3000`.

`postgres`/`redis`/`worker` ficam na rede `internal` privada, sem exposição.

> A rede `proxy_network` já existe no servidor (é externa a este compose). Não
> precisa criá-la. Nunca derrube o Traefik nem os containers de clientes.

## Rollback

```bash
cd $DEPLOY_DIR
IMAGE_TAG=<sha-anterior> docker compose -f docker-compose.prod.yml up -d
```

## Migrações

Aplicadas automaticamente no start do `app` pelo `docker-entrypoint.sh`
(`prisma migrate deploy`, idempotente). Falha de migração aborta o boot sem
subir o app (Req. 18.7/18.8).

## Webhook do WhatsApp

Após o primeiro deploy, configurar no app Meta:
`https://csc.nitecnologia.tec.br/api/webhooks/whatsapp` (ver `docs/whatsapp-setup.md`).
