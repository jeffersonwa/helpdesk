# Manual de Operação — JÁ Helpdesk

Guia prático para **adicionar empresas, usuários e clientes** e entender o
**fluxo de trabalho** dos chamados.

- URL de produção: **https://csc.nitecnologia.tec.br**
- Login em `/login` com e-mail e senha.

Este manual reflete o comportamento real da aplicação. As telas disponíveis no
menu lateral mudam conforme o **perfil** do usuário logado.

---

## 1. Perfis de acesso (papéis)

O que cada perfil enxerga e pode fazer. A autorização é validada no **backend** —
ocultar botões não é o controle; o servidor sempre confere o papel e o tenant
(empresa) do usuário.

| Perfil | Para quê serve | Acessos principais |
| --- | --- | --- |
| **SUPERADMIN** | Administração da plataforma (todas as empresas) | Tudo, incluindo **Empresas** |
| **ADMIN** | Administra **uma** empresa (tenant) | Tickets, Filas, Catálogo, Usuários, Relatórios, RBAC, Canais |
| **SERVICE_MANAGER** (Gestor) | Gestão de atendimento | Tickets, Filas, Catálogo |
| **SUPERVISOR** | Supervisão de filas/equipe | Tickets, Filas |
| **AGENT** (Agente) | Atende os chamados | Tickets, Conversas, Relatórios |
| **CLIENT** (Cliente/Solicitante) | Abre e acompanha os próprios chamados | Portal de autoatendimento |

Observação importante sobre **isolamento por empresa (multi-tenant)**: cada
usuário só enxerga dados da **própria empresa**. O único que cruza empresas é o
SUPERADMIN, e apenas em operações de plataforma.

---

## 2. Adicionar uma EMPRESA (apenas SUPERADMIN)

Cada empresa (tenant) é isolada das demais. Ao criar a empresa, você também
define o **primeiro usuário Admin** dela.

1. Faça login como **SUPERADMIN**.
2. No menu lateral, abra **Empresas**.
3. No painel **"Nova empresa"** (à direita), preencha:
   - **Nome da empresa** — ex.: `Acme Ltda`.
   - **Slug** — identificador em minúsculas/números/hífen (gerado automaticamente
     a partir do nome; pode ajustar). Ex.: `acme`.
   - **Usuário Admin inicial**: Nome, E-mail e Senha (mínimo 6 caracteres).
4. Clique em **Criar empresa**.

Pronto: a empresa aparece na lista com contadores de usuários e tickets. O Admin
inicial já pode entrar e cadastrar o resto da equipe e os clientes.

> Para **remover** uma empresa, use o botão de exclusão no cartão dela (não é
> possível excluir a sua própria empresa).

---

## 3. Adicionar USUÁRIOS e CLIENTES (ADMIN ou SUPERADMIN)

No JÁ Helpdesk, **cliente é um usuário com o perfil "Cliente" (CLIENT)**. Ou
seja, agentes, admins e clientes são todos criados na mesma tela **Usuários** —
o que muda é o **perfil** escolhido.

1. Faça login como **ADMIN** (ou SUPERADMIN).
2. No menu lateral, abra **Usuários**.
3. No formulário **"Adicionar usuário"**, preencha:
   - **Nome** (obrigatório)
   - **E-mail** (obrigatório, único)
   - **Telefone** e **Celular** (opcionais)
   - **Senha** (obrigatória, mínimo 6 caracteres)
   - **Perfil** (obrigatório):
     - **Cliente** → para solicitantes que só abrem/acompanham chamados (portal).
     - **Agente** → para quem atende os chamados.
     - **Admin** → para quem administra a empresa.
4. Clique em **Criar usuário**.

O usuário é criado **na sua empresa** automaticamente (o sistema deriva o tenant
da sua sessão — você não escolhe a empresa aqui). Depois é possível **editar** o
usuário ou **redefinir a senha** dele pela própria tela de Usuários.

> Dica: para cadastrar um cliente, escolha o perfil **Cliente**. Ele vai logar e
> ver o **portal de autoatendimento** (não o console de atendimento).

---

## 4. Estruturar o atendimento (opcional, recomendado)

Antes de operar em volume, o **ADMIN / Gestor** pode organizar a operação em:

- **Catálogo** (menu **Catálogo**): Serviços → Categorias → Subcategorias →
  Itens de categoria. Serve para classificar os chamados.
- **Filas** (menu **Filas**): caixas de trabalho por assunto/equipe. Uma fila
  pode ser marcada como **padrão**.
- Equipes, Unidades e Departamentos ficam disponíveis para classificar e
  direcionar os chamados no momento da abertura.

Esses itens são **por empresa** e aparecem como opções ao abrir um novo ticket.

---

## 5. Fluxo de trabalho de um chamado (ticket)

### 5.1 Como um chamado entra

- **Portal** (o cliente abre em `/portal` → "Novo chamado").
- **Console** (agente/admin abre em **Tickets → Novo Ticket**).
- **Omnichannel**: WhatsApp (Cloud API oficial), e-mail, formulário público e
  API — quando os canais estiverem configurados em **Admin → Canais**.

Ao abrir pelo console, os campos incluem: título, descrição, solicitante,
serviço, categoria/subcategoria/item, impacto, urgência, fila, equipe, unidade,
departamento. A **prioridade é derivada** de impacto × urgência (não é escolhida
manualmente).

### 5.2 Ciclo de vida (status)

```
Aberto → Em andamento → (Aguardando) → Resolvido → Fechado
                              │
                              └→ Aguardando aprovação → Fechado (aprovado)
                                                     └→ Em andamento (rejeitado)
        Cancelado (encerrado sem solução)
```

| Status | Significado |
| --- | --- |
| **Aberto** | Chamado registrado, ainda não iniciado |
| **Em andamento** | Agente trabalhando na solução |
| **Aguardando** | Parado aguardando terceiro/solicitante |
| **Aguardando aprovação** | Solução proposta, aguardando o cliente aprovar |
| **Resolvido** | Solução aplicada |
| **Fechado** | Encerrado |
| **Cancelado** | Encerrado sem solução |

### 5.3 O que o AGENTE faz (console: Tickets → abrir o chamado → "Ações")

- **Status**: mover o chamado pelo ciclo de vida.
- **Prioridade**: ajustar quando necessário.
- **Responsável**: atribuir o chamado a um agente.
- **Comentários**: registrar o andamento na conversa do ticket.

### 5.4 Aprovação pelo CLIENTE

Quando um chamado vai para **Aguardando aprovação**, o solicitante vê um aviso no
ticket e decide:

- **Aprovar** → o chamado é **fechado**.
- **Rejeitar** → o chamado volta para **Em andamento** para o agente continuar.

O agente é notificado por e-mail do resultado.

### 5.5 SLA, prioridade e escalonamento

- A **prioridade** é derivada automaticamente (impacto × urgência).
- Os **prazos de SLA** são calculados quando há regra configurada para a
  prioridade; sem regra, o chamado é criado sem prazos (e isso fica sinalizado).
- Rotinas em segundo plano cuidam de **escalonamento** e de **aprovações
  automáticas** conforme as regras.

---

## 6. Papéis, permissões e escopos avançados (RBAC)

Para controle fino além dos perfis básicos, o ADMIN/SUPERADMIN usa
**Admin → RBAC**: criar papéis personalizados, permissões e escopos (por
unidade, departamento, equipe, fila, categoria etc.) e atribuí-los a usuários.

Papéis **globais de plataforma** só podem ser geridos pelo SUPERADMIN.

---

## 7. Roteiro rápido para começar do zero

1. **SUPERADMIN** → **Empresas** → cria a empresa + Admin inicial.
2. **Admin da empresa** faz login e:
   - **Catálogo** → cadastra Serviços/Categorias.
   - **Filas** → cria as filas (marque uma como padrão).
   - **Usuários** → cadastra **Agentes** e **Clientes**.
3. **Clientes** abrem chamados pelo **portal**; **Agentes** atendem pelo console
   (**Tickets**), movendo status, atribuindo responsável e comentando.
4. Chamados que exigem aceite vão para **Aguardando aprovação**; o cliente
   aprova/rejeita.
5. Acompanhe indicadores em **Relatórios**.

---

## 8. Dúvidas comuns

- **"Não vejo o menu Empresas."** Só o SUPERADMIN vê. Admin de empresa gerencia
  apenas a própria empresa (Usuários, Catálogo, Filas etc.).
- **"Criei um usuário na empresa errada."** Não é possível: o usuário é sempre
  criado na empresa do administrador logado (derivada da sessão).
- **"Cliente não acessa o console."** É o esperado. Cliente usa o **portal** de
  autoatendimento; o console é para a equipe de atendimento.
- **"Esqueci/preciso trocar a senha de um usuário."** Use **Usuários →
  redefinir senha** (Admin/SUPERADMIN).
