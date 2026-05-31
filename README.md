# Helpdesk

Sistema de helpdesk multi-empresa com abertura de chamados via email, fluxo de aprovação de solução e SLA automático.

**Demo:** https://helpdesk-pi-teal.vercel.app

---

## Funcionalidades

- **Multi-tenant** — cada empresa tem usuários e chamados isolados por `company_id`
- **Abertura de chamados via email** — envie um email para `tickets@seudominio.com` e o chamado é criado automaticamente (somente usuários cadastrados)
- **Fluxo de aprovação** — agente marca como resolvido → cliente aprova ou rejeita → chamado fechado ou reaberto
- **SLA automático** — prazo calculado por prioridade com indicadores de violação/alerta
- **Papéis de usuário** — SUPERADMIN, ADMIN, AGENT, CLIENT com permissões distintas
- **Notificações por email** — eventos de aprovação, rejeição e criação via email

---

## Papéis de usuário

| Papel | Capacidades |
|-------|-------------|
| **SUPERADMIN** | Acesso global a todas as empresas |
| **ADMIN** | Gerencia usuários, pode fechar chamados sem aprovação |
| **AGENT** | Atende chamados, marca como resolvido (vai para aprovação) |
| **CLIENT** | Abre chamados, aprova ou rejeita soluções |

---

## Arquitetura

```
src/
├── app/
│   ├── (app)/                    # Rotas autenticadas
│   │   ├── dashboard/            # Visão geral com métricas
│   │   ├── tickets/
│   │   │   ├── page.tsx          # Lista de chamados
│   │   │   ├── new/              # Formulário de novo chamado
│   │   │   └── [id]/
│   │   │       ├── page.tsx          # Detalhe do chamado
│   │   │       ├── ApprovalBanner.tsx # Banner de aprovação (CLIENT)
│   │   │       ├── TicketActions.tsx  # Ações do agente
│   │   │       └── CommentForm.tsx    # Formulário de comentário
│   │   ├── users/                # Gerenciamento de usuários
│   │   └── reports/              # Relatórios por status e prioridade
│   ├── (auth)/
│   │   ├── login/
│   │   └── register/             # Cadastro de empresa + usuário admin
│   └── api/
│       ├── auth/                 # NextAuth handlers + registro
│       ├── tickets/
│       │   └── [id]/
│       │       └── approve/      # Endpoint de aprovação/rejeição
│       ├── users/
│       ├── reports/
│       └── webhooks/
│           └── email/            # Webhook inbound do Resend
├── lib/
│   ├── auth.ts                   # Configuração NextAuth (com Prisma)
│   ├── auth.config.ts            # Config edge-safe (sem Prisma)
│   ├── email.ts                  # Cliente Resend
│   ├── prisma.ts                 # Singleton Prisma com adapter pg
│   └── sla.ts                   # Cálculo de prazo SLA
└── middleware.ts                 # Proteção de rotas (edge-safe)
prisma/
├── schema.prisma                 # Modelos: Company, User, Ticket, Comment, SlaRule
└── migrations/
```

### Ciclo de vida do chamado

```
OPEN → IN_PROGRESS → WAITING → PENDING_APPROVAL → CLOSED
                                      ↓
                                  IN_PROGRESS  (se rejeitado)
```

---

## Setup local

### Pré-requisitos
- Node.js 20+
- Banco PostgreSQL (recomendado: [Neon](https://neon.tech) — gratuito)
- Conta no [Resend](https://resend.com) — plano gratuito suficiente

### Passos

```bash
# 1. Clonar o repositório
git clone https://github.com/seu-usuario/helpdesk.git
cd helpdesk

# 2. Instalar dependências
npm install

# 3. Configurar variáveis de ambiente
cp .env.example .env.local
# Edite .env.local com suas credenciais

# 4. Rodar migrations do banco
./node_modules/.bin/prisma migrate dev

# 5. Iniciar servidor de desenvolvimento
npm run dev
```

Acesse: http://localhost:3000

Crie sua empresa em `/register`.

---

## Variáveis de ambiente

| Variável | Descrição |
|----------|-----------|
| `DATABASE_URL` | Connection string PostgreSQL (ex: `postgresql://user:pass@host/db?sslmode=require`) |
| `AUTH_SECRET` | Segredo para assinar sessões next-auth. Gere com: `openssl rand -base64 32` |
| `AUTH_URL` | URL base do app (ex: `https://meuapp.vercel.app`) |
| `NEXTAUTH_URL` | Mesmo valor que `AUTH_URL` |
| `RESEND_API_KEY` | Chave de API do Resend (começa com `re_`) |
| `RESEND_FROM_EMAIL` | Endereço de envio verificado no Resend |
| `RESEND_WEBHOOK_SECRET` | Secret HMAC para validar webhooks do Resend |

---

## Banco de dados

**ORM:** Prisma 7 com driver pg  
**Banco:** PostgreSQL (Neon recomendado para Vercel)

### Rodar migrations

```bash
# Desenvolvimento
./node_modules/.bin/prisma migrate dev --name nome-da-migration

# Produção
DATABASE_URL="<url-producao>" ./node_modules/.bin/prisma migrate deploy
```

### Inspecionar dados localmente

```bash
./node_modules/.bin/prisma studio
```

---

## Abertura de chamados via email

### Como funciona

1. Usuário envia email para `tickets@seudominio.com`
2. Resend recebe e chama o webhook `POST /api/webhooks/email`
3. Sistema verifica se o remetente tem cadastro
   - **Cadastrado** → chamado criado + email de confirmação
   - **Não cadastrado** → email de rejeição explicando como criar conta

### Configuração no Resend

1. Acesse [resend.com](https://resend.com) e adicione seu domínio em **Domains**
2. Verifique o domínio seguindo as instruções DNS fornecidas
3. Adicione o registro MX no seu DNS:
   - **Host:** `tickets` (ou o subdomínio que preferir)
   - **Value:** `inbound.resend.com`
   - **Priority:** `10`
4. Em **Inbound** no Resend, crie uma rota:
   - **Match:** `*@tickets.seudominio.com`
   - **Webhook URL:** `https://seu-app.vercel.app/api/webhooks/email`
5. Copie o **Webhook Secret** e adicione como `RESEND_WEBHOOK_SECRET`

---

## Deploy na Vercel

```bash
# Primeiro deploy (instala Neon automaticamente)
npx vercel install neon --name helpdesk-db --plan free_v3 -e production -e preview
npx vercel --prod

# Configurar variáveis de ambiente
npx vercel env add RESEND_API_KEY
npx vercel env add RESEND_FROM_EMAIL
npx vercel env add RESEND_WEBHOOK_SECRET
npx vercel env add NEXTAUTH_URL
npx vercel env add AUTH_URL

# Rodar migrations em produção
npx vercel env pull --environment production
DATABASE_URL="$(grep DATABASE_URL .env.local | cut -d= -f2- | tr -d '"')" \
  ./node_modules/.bin/prisma migrate deploy
```

O script `build` executa `prisma generate` automaticamente antes do Next.js build.

---

## Referência da API

### Chamados

| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `GET` | `/api/tickets` | Lista chamados (filtros: `?status=OPEN&priority=HIGH`) | ✓ |
| `POST` | `/api/tickets` | Cria chamado | ✓ |
| `GET` | `/api/tickets/[id]` | Detalhes do chamado | ✓ |
| `PATCH` | `/api/tickets/[id]` | Atualiza status, prioridade, responsável | ✓ |
| `PATCH` | `/api/tickets/[id]/approve` | Aprova ou rejeita solução | ✓ |
| `POST` | `/api/tickets/[id]/comments` | Adiciona comentário | ✓ |

### Usuários

| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `GET` | `/api/users` | Lista usuários da empresa | ADMIN+ |
| `POST` | `/api/users` | Cria usuário na empresa | ADMIN+ |

### Webhooks

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/api/webhooks/email` | Recebe email inbound do Resend |

#### `PATCH /api/tickets/[id]/approve`

```json
{ "action": "approve" }
```
ou
```json
{ "action": "reject" }
```

- `approve` → status: `CLOSED` + notifica agente
- `reject` → status: `IN_PROGRESS` + notifica agente

Permitido: criador do chamado (CLIENT) ou ADMIN/SUPERADMIN.

---

## SLA padrão

| Prioridade | Prazo de resolução |
|------------|--------------------|
| Crítica | 4 horas |
| Alta | 8 horas |
| Média | 24 horas |
| Baixa | 72 horas |

Os prazos podem ser personalizados por empresa na tabela `SlaRule`.

---

## Stack

- **Framework:** Next.js 16 (App Router)
- **Banco:** PostgreSQL via Prisma 7 + adapter pg
- **Auth:** NextAuth v5 (credentials)
- **Email:** Resend
- **UI:** Tailwind CSS v4
- **Validação:** Zod v4
- **Deploy:** Vercel + Neon
