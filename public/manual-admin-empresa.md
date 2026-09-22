# Manual do Administrador da Empresa — JÁ Helpdesk

Guia para o **Admin de uma empresa** (tenant): cadastrar a equipe e os clientes,
organizar o atendimento e acompanhar os chamados.

- URL: **https://csc.nitecnologia.tec.br** · Login em `/login`.
- Você administra **apenas a sua empresa**. Os dados de outras empresas nunca
  aparecem para você (isolamento multi-tenant).

---

## 1. Seu acesso (perfil ADMIN)

No menu lateral você tem acesso a: **Dashboard**, **Tickets**, **Conversas**,
**Filas**, **Catálogo**, **Usuários**, **Relatórios** e a seção **Admin**
(RBAC e Canais). O menu **Empresas** é exclusivo da plataforma (SUPERADMIN) e
não aparece para você.

Perfis que você pode atribuir aos seus usuários:

| Perfil | Para quê serve |
| --- | --- |
| **Cliente** | Abre e acompanha os próprios chamados (usa o portal) |
| **Agente** | Atende os chamados no console |
| **Admin** | Administra a empresa (como você) |

---

## 2. Cadastrar usuários e clientes

No JÁ Helpdesk, **cliente é um usuário com o perfil "Cliente"**. Agentes, admins
e clientes são criados na mesma tela — o que muda é o **perfil**.

1. Menu **Usuários**.
2. No formulário **"Adicionar usuário"**:
   - **Nome** (obrigatório)
   - **E-mail** (obrigatório, único)
   - **Telefone** e **Celular** (opcionais)
   - **Senha** (mínimo 6 caracteres)
   - **Perfil**: Cliente, Agente ou Admin
3. Clique em **Criar usuário**.

O usuário é criado automaticamente **na sua empresa** (você não escolhe a
empresa — o sistema usa a sua). Depois é possível **editar** o usuário ou
**redefinir a senha** pela mesma tela.

> Para um solicitante que só abre chamados, escolha **Cliente** — ele entrará no
> **portal de autoatendimento**.

---

## 3. Organizar o atendimento

Recomendado antes de operar em volume:

- **Catálogo**: Serviços → Categorias → Subcategorias → Itens. Classifica os
  chamados.
- **Filas**: caixas de trabalho por assunto/equipe. Marque uma como **padrão**.
- Equipes, Unidades e Departamentos ficam disponíveis para direcionar os
  chamados na abertura.

Tudo isso é **por empresa** e aparece como opção ao abrir um novo ticket.

---

## 4. Fluxo de trabalho dos chamados

### 4.1 Entradas
- **Portal** (cliente abre em `/portal`).
- **Console** (Agente/Admin: **Tickets → Novo Ticket**).
- **Omnichannel**: WhatsApp (Cloud API oficial), e-mail, formulário público e
  API — configuráveis em **Admin → Canais**.

Na abertura pelo console há: título, descrição, solicitante, serviço,
categoria/subcategoria/item, impacto, urgência, fila, equipe, unidade,
departamento. A **prioridade é derivada** de impacto × urgência.

### 4.2 Ciclo de vida (status)

```
Aberto → Em andamento → (Aguardando) → Resolvido → Fechado
                              │
                              └→ Aguardando aprovação → Fechado (aprovado)
                                                     └→ Em andamento (rejeitado)
        Cancelado (encerrado sem solução)
```

| Status | Significado |
| --- | --- |
| **Aberto** | Registrado, ainda não iniciado |
| **Em andamento** | Agente trabalhando |
| **Aguardando** | Parado aguardando terceiro/solicitante |
| **Aguardando aprovação** | Solução proposta, aguardando o cliente aprovar |
| **Resolvido** | Solução aplicada |
| **Fechado** | Encerrado |
| **Cancelado** | Encerrado sem solução |

### 4.3 Ações do agente (Tickets → abrir o chamado → "Ações")
- **Status**: mover pelo ciclo de vida.
- **Prioridade**: ajustar quando necessário.
- **Responsável**: atribuir a um agente.
- **Comentários**: registrar andamento.

### 4.4 Aprovação pelo cliente
Chamado em **Aguardando aprovação**: o solicitante **Aprova** (fecha) ou
**Rejeita** (volta para Em andamento). O agente é notificado por e-mail.

### 4.5 SLA e escalonamento
Prioridade derivada automaticamente; prazos de SLA calculados quando há regra
para a prioridade. Rotinas em segundo plano cuidam de escalonamento e aprovação
automática conforme as regras.

---

## 5. Permissões avançadas (RBAC)

Em **Admin → RBAC** você cria papéis personalizados, permissões e escopos (por
unidade, departamento, equipe, fila, categoria) e os atribui a usuários. Papéis
globais de plataforma não são geridos aqui (são do SUPERADMIN).

---

## 6. Relatórios

Em **Relatórios** você acompanha os indicadores de atendimento da sua empresa
(volume, status, SLA) por período.

---

## 7. Roteiro rápido

1. **Catálogo** → cadastre Serviços/Categorias.
2. **Filas** → crie as filas (uma padrão).
3. **Usuários** → cadastre Agentes e Clientes.
4. Clientes abrem chamados no **portal**; Agentes atendem em **Tickets**.
5. Chamados que exigem aceite vão para **Aguardando aprovação**.
6. Acompanhe em **Relatórios**.

---

## 8. Dúvidas comuns

- **"Não vejo o menu Empresas."** É exclusivo da plataforma (SUPERADMIN). Você
  administra apenas a sua empresa.
- **"Criei um usuário na empresa errada."** Não é possível: o usuário é sempre
  criado na sua empresa.
- **"Cliente não entra no console."** Correto — cliente usa o **portal**.
- **"Trocar a senha de um usuário."** Use **Usuários → redefinir senha**.
