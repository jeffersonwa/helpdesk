# Requirements Document

*Documento de Requisitos: JÁ Helpdesk — Plataforma Omnichannel*

## Introduction

*Introdução*

O **JÁ Helpdesk** é uma plataforma de atendimento omnichannel corporativa que centraliza solicitações vindas de portal web, WhatsApp Business Platform (Cloud API oficial da Meta), e-mail, formulário público, API e integrações futuras, convertendo-as em conversas e/ou tickets rastreáveis com SLA, prioridades, escalonamentos, aprovações e histórico auditável. O produto opera como **SaaS multi-tenant** e em **instalação on-premises** via Docker Compose, com arquitetura preparada (mas não dependente) de Kubernetes.

Estes requisitos são **derivados do documento de design aprovado** (`design.md`) e refletem o escopo completo do produto. Cada requisito segue o formato EARS (Ubiquitous, Event-driven, State-driven, Unwanted event, Optional feature, Complex) e as regras de qualidade INCOSE. As decisões técnicas de suporte (padrão provider/adapter, outbox transacional, motores puros de prioridade/SLA/escalonamento, modelo RBAC por permissão+escopo) estão detalhadas no design.

As **12 propriedades de correção** para testes baseados em propriedades estão definidas na seção *Correctness Properties* de `design.md` e são referenciadas nos requisitos correspondentes desta especificação.

## Glossary

- **JÁ_Helpdesk (Sistema)**: A plataforma de atendimento omnichannel completa descrita nesta especificação.
- **Tenant**: Cliente isolado da plataforma, representado pelo modelo `Company`. É o eixo raiz de isolamento de dados.
- **companyId**: Identificador do tenant, derivado no servidor a partir da sessão autenticada; nunca aceito do corpo da requisição do cliente.
- **RBAC_Engine (Motor de Autorização)**: Componente de backend (`Authorization`) que decide `can(user, action, resource)` com base em papéis, permissões e escopos.
- **RoleDef (Papel)**: Definição de papel que agrega permissões; pode ser global de plataforma (`companyId = null`) ou por tenant.
- **Permission (Permissão)**: Ação autorizável no formato `dominio.acao` (ex.: `ticket.assign`).
- **Scope (Escopo)**: Delimitação de onde uma permissão vale (níveis TENANT, UNIT, DEPARTMENT, TEAM, QUEUE, CATEGORY, TICKET).
- **Ticket**: Registro rastreável de uma solicitação de atendimento, com número sequencial por tenant, ciclo de vida e SLA.
- **Conversation (Conversa)**: Sequência de mensagens de um contato em um canal, vinculável a tickets.
- **Message (Mensagem)**: Unidade de comunicação (inbound/outbound) pertencente a uma conversa.
- **ChannelAdapter (Adaptador de Canal)**: Contrato comum que cada canal implementa (verificar assinatura, normalizar entrada, enviar saída, capacidades).
- **IngestionRouter (Roteador de Ingestão)**: Componente que recebe `InboundMessage` normalizado e decide criação/atualização de conversa e ticket.
- **InboundMessage**: Mensagem normalizada independente de canal usada internamente pela ingestão.
- **WhatsAppCloudAdapter**: Adaptador de integração real com a Meta WhatsApp Business Cloud API oficial.
- **WhatsAppMockAdapter**: Provider de desenvolvimento que implementa a mesma interface sem chamadas externas; bloqueado em produção.
- **ChannelAccount (Conta de Canal)**: Configuração de uma conta de um canal para um tenant (ex.: `phone_number_id` do WhatsApp), com `secretRef`.
- **secretRef**: Referência a um segredo armazenado em env/secret manager; nunca contém o valor do segredo.
- **PriorityEngine (Motor de Prioridade)**: Função pura `derivePriority(impact, urgency)` que deriva a prioridade pela matriz impacto × urgência.
- **SlaEngine (Motor de SLA)**: Funções puras `calcSla` e `slaStatus` para prazos de resposta/resolução e status.
- **EscalationEngine (Motor de Escalonamento)**: Componente que seleciona e aplica regras de escalonamento (`selectEscalations`).
- **ApprovalEngine (Motor de Aprovação)**: Componente que gerencia solicitações e decisões de aprovação de tickets.
- **AuditService (Serviço de Auditoria)**: Componente que grava trilha imutável (`AuditLog`) de operações sensíveis.
- **Outbox**: Tabela transacional (`OutboxEvent`) para efeitos externos processados por workers idempotentes.
- **WebhookDispatcher**: Componente que dispara webhooks de saída assinados por HMAC.
- **Janela_de_24h**: Período de 24 horas após a última mensagem do contato do WhatsApp durante o qual mensagens de formato livre são permitidas.
- **KnowledgeBase (Base de Conhecimento)**: Conjunto de artigos (`KbArticle`) para autoatendimento.
- **LGPD**: Lei Geral de Proteção de Dados; conjunto de requisitos de base legal, retenção, direitos do titular e minimização de dados pessoais.
- **PII**: Informação Pessoal Identificável (Personally Identifiable Information).

## Requirements

### Requirement 1: Multi-tenancy e isolamento de tenant

**User Story:** Como operador da plataforma, quero que todos os dados sejam isolados por tenant, para que nenhum cliente acesse dados de outro cliente.

#### Acceptance Criteria

1. THE JÁ_Helpdesk SHALL derivar o `companyId` de toda operação exclusivamente a partir da sessão autenticada no servidor.
2. WHEN uma requisição de cliente inclui um `companyId` no corpo, THE JÁ_Helpdesk SHALL ignorar esse valor e usar o `companyId` derivado da sessão do servidor.
3. THE JÁ_Helpdesk SHALL filtrar toda consulta de entidade de negócio pelo `companyId` derivado no servidor, retornando apenas registros cujo `companyId` seja igual ao da sessão.
4. IF a sessão autenticada não possui um `companyId` associado, THEN THE JÁ_Helpdesk SHALL rejeitar a operação sem acessar nenhuma entidade de negócio e retornar uma indicação de erro de autorização ao chamador.
5. IF o `companyId` de um recurso difere do `companyId` do usuário, THEN THE RBAC_Engine SHALL negar a operação, retornar uma indicação de erro de autorização ao chamador e manter o recurso inalterado. **(Ref. design: Correctness Property 6)**
6. IF o `companyId` de uma `ChannelAccount` difere do `companyId` da `InboundMessage` durante a ingestão, THEN THE IngestionRouter SHALL rejeitar o evento sem persistir a mensagem e registrar uma indicação de rejeição por incompatibilidade de tenant.
7. THE JÁ_Helpdesk SHALL armazenar o `companyId` em toda entidade de negócio persistida, recusando a persistência de qualquer entidade de negócio sem `companyId`.

### Requirement 2: Autenticação e autorização (RBAC no backend)

**User Story:** Como administrador de tenant, quero que o controle de acesso seja aplicado no backend com permissões e escopos granulares, para que a segurança não dependa da interface.

#### Acceptance Criteria

1. THE RBAC_Engine SHALL aplicar decisões de autorização no backend para toda ação que crie, leia, altere ou exclua recursos de tenant ou que execute operações de plataforma, avaliando a autorização antes de qualquer efeito colateral sobre os dados.
2. IF a interface oculta ou desabilita um botão ou opção, THEN THE JÁ_Helpdesk SHALL ainda validar a permissão no backend antes de executar a ação correspondente, sem depender de qualquer sinal proveniente da interface.
3. WHEN `RBAC_Engine.can(user, action, resource)` é avaliado, THE RBAC_Engine SHALL permitir a ação somente se a permissão existe entre os papéis atribuídos ao usuário E ao menos um escopo desse papel cobre o recurso E o recurso pertence ao mesmo tenant; em qualquer outro caso THE RBAC_Engine SHALL negar a ação.
4. WHERE um escopo é de nível TENANT, THE RBAC_Engine SHALL considerar coberto qualquer recurso do mesmo tenant cuja ação esteja nas permissões. **(Ref. design: Correctness Property 7)**
5. WHERE um escopo é de nível mais restrito (UNIT, DEPARTMENT, TEAM, QUEUE, CATEGORY ou TICKET) com um `refId`, THE RBAC_Engine SHALL negar o acesso a recursos fora daquele `refId`. **(Ref. design: Correctness Property 7)**
6. WHERE um escopo possui `refId` nulo, THE RBAC_Engine SHALL cobrir todos os recursos daquele nível dentro do tenant.
7. IF `RBAC_Engine.assert` é chamado e a autorização é negada, THEN THE JÁ_Helpdesk SHALL lançar um erro de autorização traduzido em resposta `403 Forbidden`, sem aplicar qualquer alteração de estado associada à ação negada.
8. WHERE um usuário é SUPERADMIN de plataforma, THE RBAC_Engine SHALL ignorar o escopo de tenant apenas para operações de plataforma explicitamente marcadas. **(Ref. design: Correctness Property 6)**
9. IF o usuário avaliado não possui nenhum papel atribuído, THEN THE RBAC_Engine SHALL negar a ação e retornar decisão negativa.
10. IF a ação ou o recurso informados não correspondem a uma permissão ou tipo de recurso reconhecido, THEN THE RBAC_Engine SHALL negar a ação por padrão (fail-closed).

### Requirement 3: Papéis customizados e grupos

**User Story:** Como administrador de tenant, quero criar papéis customizados combinando permissões e escopos, para que a autorização reflita a estrutura da minha organização.

#### Acceptance Criteria

1. WHEN um administrador de tenant submete a criação de um `RoleDef` com um nome de 1 a 100 caracteres, ao menos 1 e no máximo 200 `Permission`, e de 0 a 50 `Scope`, THE JÁ_Helpdesk SHALL persistir o `RoleDef` vinculado ao tenant e retornar confirmação com o identificador criado.
2. IF a criação de um `RoleDef` é submetida sem nenhuma `Permission`, com nome vazio ou com nome já existente no mesmo tenant, THEN THE JÁ_Helpdesk SHALL rejeitar a operação, não persistir o `RoleDef` e retornar mensagem de erro indicando a violação específica (permissões ausentes, nome vazio ou nome duplicado).
3. THE JÁ_Helpdesk SHALL disponibilizar, como papéis pré-definidos, os perfis Superadmin de plataforma, Admin de tenant, Gestor de serviço, Supervisor, Agente, Especialista L2/L3, Aprovador, Auditor, Somente leitura, Conta de integração, Conta de serviço e Solicitante/Cliente.
4. WHEN um `RoleDef` é atribuído a um usuário via `RoleAssignment`, THE JÁ_Helpdesk SHALL vincular os escopos definidos no `RoleDef` a essa atribuição e retornar confirmação da atribuição.
5. IF é solicitada a atribuição de um `RoleDef` a um usuário que já possui esse mesmo `RoleDef` no mesmo escopo, THEN THE JÁ_Helpdesk SHALL rejeitar a operação, manter a atribuição existente inalterada e retornar mensagem de erro indicando atribuição duplicada.
6. WHERE um `RoleDef` tem `companyId` nulo, THE JÁ_Helpdesk SHALL tratá-lo como papel global de plataforma aplicável a todos os tenants.

### Requirement 4: Gestão de tickets e ciclo de vida

**User Story:** Como agente de atendimento, quero criar e gerenciar tickets com campos estruturados e ciclo de vida definido, para que as solicitações sejam rastreáveis e organizadas.

#### Acceptance Criteria

1. WHEN um ticket é criado por origem manual, portal, WhatsApp, e-mail, API ou formulário público seguro, THE JÁ_Helpdesk SHALL registrar sua origem (`origin`) correspondente.
2. THE JÁ_Helpdesk SHALL armazenar em cada ticket os campos número sequencial, título, descrição, solicitante, empresa, unidade, departamento, serviço, categoria, subcategoria, item de categoria, impacto, urgência, prioridade, origem, fila, agente responsável e time.
3. WHEN um ticket é criado com título de 1 a 200 caracteres e descrição de 1 a 5.000 caracteres, THE JÁ_Helpdesk SHALL atribuir um número sequencial configurável e único por tenant e definir o status inicial como OPEN.
4. IF um ticket é submetido sem título, sem descrição, sem solicitante ou sem empresa, THEN THE JÁ_Helpdesk SHALL rejeitar a criação, não persistir o ticket e retornar mensagem de erro indicando o campo obrigatório ausente.
5. WHEN múltiplos tickets são criados concorrentemente no mesmo tenant, THE JÁ_Helpdesk SHALL garantir que todos os `Ticket.number` sejam distintos e contíguos. **(Ref. design: Correctness Property 8)**
6. THE JÁ_Helpdesk SHALL restringir o status do ticket aos valores OPEN, IN_PROGRESS, WAITING, PENDING_APPROVAL, RESOLVED, CLOSED e CANCELLED, e o impacto e a urgência aos valores LOW, MEDIUM e HIGH.
7. WHEN o impacto ou a urgência de um ticket é definido ou alterado, THE PriorityEngine SHALL derivar a prioridade a partir da matriz impacto × urgência.
8. IF há colisão de unicidade em `@@unique([companyId, number])` sob concorrência, THEN THE JÁ_Helpdesk SHALL repetir a obtenção do próximo número em até 5 tentativas, sem persistir numeração duplicada.
9. IF as tentativas de obtenção de número sequencial se esgotam sem sucesso, THEN THE JÁ_Helpdesk SHALL rejeitar a criação do ticket, não persistir o ticket e retornar uma indicação de erro de conflito de numeração.

### Requirement 5: Ingestão omnichannel via provider/adapter

**User Story:** Como gestor de atendimento, quero receber solicitações de múltiplos canais por uma camada de ingestão unificada, para que todos os canais sejam tratados de forma consistente.

#### Acceptance Criteria

1. THE JÁ_Helpdesk SHALL expor uma interface comum `ChannelAdapter` implementada por cada canal, contendo no mínimo as operações de recepção de evento bruto, normalização em `InboundMessage` e envio de mensagem com retorno `SendResult`.
2. WHEN um evento bruto chega de um canal, THE ChannelAdapter SHALL verificar a assinatura do evento dentro de 5 segundos e, se a assinatura for válida, normalizá-lo em uma `InboundMessage` contendo identificador do canal, identificador da `ChannelAccount`, identificador externo do remetente, conteúdo e timestamp.
3. IF a assinatura do evento bruto for inválida ou ausente, THEN THE ChannelAdapter SHALL rejeitar o evento sem criar `InboundMessage`, sem criar `Message` ou `Ticket`, e SHALL retornar uma indicação de erro informando falha de verificação de assinatura.
4. WHEN o IngestionRouter recebe uma `InboundMessage`, THE IngestionRouter SHALL resolver o tenant a partir da `ChannelAccount` e criar ou atualizar a conversa e o ticket conforme as regras de roteamento.
5. IF o IngestionRouter não conseguir resolver o tenant a partir da `ChannelAccount`, THEN THE IngestionRouter SHALL descartar a `InboundMessage` sem criar `Message` ou `Ticket` e SHALL registrar uma indicação de erro informando `ChannelAccount` não resolvida.
6. WHEN a mesma `InboundMessage`, identificada pelo mesmo identificador externo de mensagem, é processada duas ou mais vezes, THE IngestionRouter SHALL criar no máximo uma `Message` e no máximo um `Ticket`. **(Ref. design: Correctness Property 5)**
7. WHERE o provider real e o provider MOCK implementam a mesma operação da interface `ChannelAdapter`, THE JÁ_Helpdesk SHALL produzir o mesmo formato e o mesmo conjunto de campos de `InboundMessage` e `SendResult` para entradas equivalentes. **(Ref. design: Correctness Property 12)**
8. WHERE `NODE_ENV` é igual a produção, THE JÁ_Helpdesk SHALL bloquear a habilitação do WhatsAppMockAdapter e SHALL retornar uma indicação de erro informando que o adaptador MOCK não é permitido em produção.

### Requirement 6: Integração WhatsApp Business Cloud API (oficial da Meta)

**User Story:** Como gestor de atendimento, quero atender clientes via WhatsApp usando exclusivamente a Cloud API oficial da Meta, para que a integração seja segura e em conformidade com os termos da Meta.

#### Acceptance Criteria

1. THE WhatsAppCloudAdapter SHALL realizar todas as chamadas de saída exclusivamente contra os endpoints da Meta WhatsApp Business Cloud API oficial (domínio `graph.facebook.com`).
2. IF uma tentativa de envio ou recebimento utiliza WhatsApp Web, QR Code, scraping, automação de navegador ou bibliotecas não oficiais, THEN THE JÁ_Helpdesk SHALL rejeitar a operação sem realizar a chamada externa e registrar um evento de auditoria indicando o motivo da rejeição.
3. WHEN uma requisição GET de verificação de webhook é recebida com `hub.mode` igual a `subscribe`, THE WhatsAppCloudAdapter SHALL responder com o valor de `hub.challenge` e status `200` somente se o `hub.verify_token` conferir exatamente com o segredo configurado.
4. IF uma requisição GET de verificação de webhook é recebida com `hub.verify_token` divergente do segredo configurado, THEN THE WhatsAppCloudAdapter SHALL responder erro `403` e não retornar o `hub.challenge`.
5. WHEN um evento POST de webhook é recebido, THE WhatsAppCloudAdapter SHALL validar o cabeçalho `X-Hub-Signature-256` via HMAC SHA-256 com comparação em tempo constante antes de processar qualquer parte do payload.
6. IF a assinatura do webhook não confere ou o cabeçalho `X-Hub-Signature-256` está ausente, THEN THE WhatsAppCloudAdapter SHALL responder erro `401` ou `403`, descartar o evento sem persistir dados e não gerar `Message`.
7. WHILE a conversa está dentro da Janela_de_24h, contada a partir da última mensagem recebida do cliente e válida por 24 horas, THE JÁ_Helpdesk SHALL permitir o envio de mensagens de sessão de formato livre.
8. IF uma `OutboundMessage` de WhatsApp está fora da Janela_de_24h e não possui `templateName` preenchido, THEN THE JÁ_Helpdesk SHALL rejeitar o envio antes de chamar a Cloud API e retornar um erro indicando que uma mensagem de template é obrigatória, preservando a `OutboundMessage` como não enviada. **(Ref. design: Correctness Property 9)**
9. WHEN mídia é recebida ou enviada, THE WhatsAppCloudAdapter SHALL utilizar os endpoints de mídia da Cloud API, armazenar o binário no object storage e guardar a referência resultante em `Message.mediaUrl`.
10. IF o download ou upload de mídia via Cloud API falha, THEN THE WhatsAppCloudAdapter SHALL registrar a falha, não gravar referência em `Message.mediaUrl` e sinalizar a mensagem como pendente de mídia, sem interromper o processamento das demais mensagens do evento.
11. THE JÁ_Helpdesk SHALL permitir que múltiplos agentes atendam simultaneamente conversas associadas a um único número oficial de WhatsApp.
12. WHEN uma mensagem com `externalId` já existente para o mesmo tenant é recebida, THE JÁ_Helpdesk SHALL tratá-la como no-op idempotente, respondendo sucesso ao webhook sem criar uma nova `Message` nem duplicar efeitos colaterais. **(Ref. design: Correctness Property 5)**

### Requirement 7: Ingestão por e-mail

**User Story:** Como solicitante, quero abrir e responder solicitações por e-mail, para que eu utilize um canal familiar sem acessar o portal.

#### Acceptance Criteria

1. WHEN um e-mail chega via inbound webhook do provedor, THE EmailAdapter SHALL verificar a assinatura do provedor e, se válida, normalizá-lo em `InboundMessage` em até 5 segundos.
2. IF a assinatura do provedor de e-mail é inválida ou ausente, THEN THE EmailAdapter SHALL rejeitar o e-mail sem criar `InboundMessage` e registrar uma indicação de falha de verificação.
3. WHERE a estratégia configurada é IMAP polling, THE EmailAdapter SHALL buscar a caixa em intervalos configuráveis de 30 a 300 segundos (padrão 60 segundos) e converter cada e-mail em `InboundMessage`.
4. IF a busca IMAP falha, THEN THE EmailAdapter SHALL repetir a busca com no máximo 3 tentativas e registrar uma indicação de erro caso todas falhem.
5. WHEN um e-mail normalizado possui `In-Reply-To`/`References` correspondentes a uma conversa ou ticket existente, THE JÁ_Helpdesk SHALL vincular a mensagem a essa conversa ou ticket.
6. WHEN um e-mail normalizado não corresponde a nenhuma conversa ou ticket existente, THE JÁ_Helpdesk SHALL criar uma nova conversa e um novo ticket vinculados ao e-mail.
7. WHEN um agente responde a um ticket originado por e-mail, THE EmailAdapter SHALL enviar a resposta ao solicitante original mantendo o cabeçalho de thread.

### Requirement 8: Formulário público seguro

**User Story:** Como solicitante sem conta, quero enviar solicitações por um formulário público, para que eu registre um chamado sem autenticação de usuário.

#### Acceptance Criteria

1. WHEN o PublicFormAdapter recebe uma submissão, THE JÁ_Helpdesk SHALL aplicar rate limiting de no máximo 5 submissões por IP por minuto e de no máximo 20 submissões por `ChannelAccount` por minuto.
2. IF o limite de rate limiting é excedido, THEN THE JÁ_Helpdesk SHALL rejeitar a submissão com status `429` e não persistir dados.
3. WHEN uma submissão de formulário público é recebida, THE JÁ_Helpdesk SHALL verificar o CAPTCHA no servidor antes de qualquer persistência.
4. IF a verificação de CAPTCHA falha, THEN THE JÁ_Helpdesk SHALL rejeitar a submissão sem persistir dados e retornar indicação de falha de verificação.
5. THE PublicFormAdapter SHALL aplicar medidas antispam incluindo honeypot, heurística de conteúdo e validação estrita com Zod, rejeitando submissões que acionem o honeypot sem persistir dados.
6. THE PublicFormAdapter SHALL derivar o escopo de tenant a partir de um token público de formulário mapeado para uma `ChannelAccount`, e não do corpo da submissão.
7. IF o token público de formulário é inválido, ausente ou expirado, THEN THE JÁ_Helpdesk SHALL rejeitar a submissão sem persistir dados e sem revelar detalhes do tenant.
8. IF a validação da submissão falha, THEN THE JÁ_Helpdesk SHALL rejeitar a requisição sem persistir dados e sem registrar PII em log.

### Requirement 9: Ingestão via API

**User Story:** Como sistema externo, quero criar e atualizar tickets via API autenticada, para que eu integre fluxos automatizados ao helpdesk.

#### Acceptance Criteria

1. WHEN uma requisição de API autenticada por conta de integração ou serviço cria ou atualiza um ticket, THE ApiAdapter SHALL processar a operação exclusivamente sob o tenant da conta autenticada, ignorando qualquer identificador de tenant informado no payload.
2. IF a requisição de API não está autenticada, THEN THE JÁ_Helpdesk SHALL rejeitar a operação com status `401` e não persistir nenhuma alteração.
3. IF a requisição de API está autenticada mas não é autorizada para a ação solicitada, THEN THE JÁ_Helpdesk SHALL rejeitar a operação com status `403` e não persistir nenhuma alteração.
4. THE ApiAdapter SHALL validar o payload de entrada com Zod antes de persistir, aplicando os seguintes limites: título entre 1 e 200 caracteres, descrição entre 1 e 5.000 caracteres, e no máximo 50 anexos por requisição.
5. IF o payload de entrada falha na validação Zod, THEN THE ApiAdapter SHALL rejeitar a operação com status `422`, retornar mensagem indicando o campo inválido e o motivo da falha, e não persistir nenhuma alteração.
6. WHEN o ApiAdapter recebe uma requisição válida, THE ApiAdapter SHALL concluir o processamento e retornar a resposta em até 2 segundos sob carga nominal.

### Requirement 10: Conversas e mensagens vinculadas a tickets

**User Story:** Como agente, quero que mensagens e conversas fiquem vinculadas aos tickets, para que eu tenha o contexto completo do atendimento.

#### Acceptance Criteria

1. WHEN uma mensagem de um contato é recebida por um canal registrado, THE ConversationService SHALL fazer upsert de exatamente uma `Conversation` identificada pela combinação de contato e canal e persistir a `Message` associada a essa conversa.
2. IF a mensagem recebida possuir o mesmo identificador único de origem de uma `Message` já persistida na mesma conversa, THEN THE ConversationService SHALL descartar a mensagem duplicada sem criar nova `Message` nem novo ticket, preservando o estado atual da conversa.
3. IF a persistência da `Conversation` ou da `Message` falhar, THEN THE ConversationService SHALL não criar nem alterar o ticket vinculado, retornar uma indicação de erro ao chamador e preservar o estado anterior da conversa.
4. WHEN uma nova mensagem é recebida e a conversa não possui ticket ativo (ticket cujo estado não é RESOLVED nem EXPIRED, ou ausência de ticket), THE IngestionRouter SHALL criar um único ticket vinculado a essa conversa e anexar a mensagem a esse ticket.
5. WHEN uma nova mensagem é recebida e a conversa possui ticket ativo (ticket cujo estado não é RESOLVED nem EXPIRED), THE IngestionRouter SHALL anexar a mensagem ao ticket ativo existente sem criar novo ticket.
6. THE JÁ_Helpdesk SHALL restringir o estado da `Conversation` exclusivamente aos valores OPEN, PENDING, RESOLVED e EXPIRED, rejeitando qualquer outro valor.
7. WHERE o canal possui janela de sessão, WHEN uma mensagem do contato é recebida, THE JÁ_Helpdesk SHALL definir `Conversation.windowExpiresAt` para o instante de recebimento da mensagem acrescido de 24 horas (86.400 segundos), em UTC.
8. IF o canal de origem da mensagem não estiver registrado no JÁ_Helpdesk, THEN THE IngestionRouter SHALL descartar a mensagem sem criar conversa nem ticket e registrar uma indicação de erro identificando o canal desconhecido.

### Requirement 11: Estrutura organizacional e catálogo de serviços

**User Story:** Como administrador de tenant, quero modelar unidades, departamentos, times, filas, categorias e catálogo de serviços de TI, para que os tickets sejam classificados e roteados corretamente.

#### Acceptance Criteria

1. WHEN um administrador de tenant submete a criação de uma unidade organizacional, departamento, time, fila, categoria, subcategoria, item de categoria ou serviço de catálogo com nome contendo de 1 a 120 caracteres, THE JÁ_Helpdesk SHALL persistir o registro associado ao tenant do administrador e torná-lo disponível para consulta.
2. IF um administrador submete a criação de qualquer entidade organizacional ou de catálogo com nome vazio, com mais de 120 caracteres, ou com nome já existente entre entidades do mesmo tipo e mesmo tenant, THEN THE JÁ_Helpdesk SHALL rejeitar a operação, preservar o estado anterior sem criar o registro e retornar mensagem de erro indicando a causa da rejeição.
3. WHERE uma unidade organizacional possui `parentId`, THE JÁ_Helpdesk SHALL representá-la em uma hierarquia de árvore com profundidade máxima de 10 níveis, contendo cada unidade no máximo um `parentId` do mesmo tenant.
4. IF a criação ou atualização de uma unidade organizacional resultaria em ciclo hierárquico ou em `parentId` pertencente a outro tenant, THEN THE JÁ_Helpdesk SHALL rejeitar a operação, preservar a hierarquia anterior e retornar mensagem de erro indicando a violação hierárquica.
5. THE JÁ_Helpdesk SHALL permitir agrupar usuários em times por meio de `TeamMember`, aceitando o mesmo usuário em múltiplos times e impedindo registros `TeamMember` duplicados para a mesma combinação de usuário e time.
6. WHERE uma fila é marcada como padrão (`isDefault`), THE IngestionRouter SHALL usá-la como destino padrão de roteamento quando nenhuma regra específica se aplica, e THE JÁ_Helpdesk SHALL garantir no máximo uma fila com `isDefault` verdadeiro por tenant.
7. THE JÁ_Helpdesk SHALL classificar categorias sob serviços de catálogo e organizar subcategorias e itens de categoria hierarquicamente, com profundidade máxima de 5 níveis (serviço de catálogo, categoria, subcategoria, item de categoria) e cada nível associado a no máximo um nó pai do mesmo tenant.

### Requirement 12: SLA, prioridades, escalonamentos e aprovações

**User Story:** Como supervisor, quero prazos de SLA, escalonamentos automáticos e aprovações, para que os atendimentos cumpram os acordos de nível de serviço.

#### Acceptance Criteria

1. WHEN um ticket é criado, THE SlaEngine SHALL calcular o prazo de resposta e o prazo de resolução a partir da `SlaRule` da prioridade do ticket.
2. WHERE uma `SlaRule` tem `responseHours ≤ resolutionHours`, THE SlaEngine SHALL produzir `responseDeadline ≤ resolutionDeadline` e ambos posteriores a `createdAt`. **(Ref. design: Correctness Property 3)**
3. WHEN `slaStatus` é avaliado para um prazo e um instante atual, THE SlaEngine SHALL retornar "breached" se e somente se o prazo é anterior ao instante atual. **(Ref. design: Correctness Property 4)**
4. WHILE um ticket permanece ativo, THE EscalationEngine SHALL avaliar as `EscalationRule` por violação de resposta, violação de resolução ou inatividade em intervalos de no máximo 5 minutos.
5. IF um gatilho de escalonamento é satisfeito e o ticket ainda não foi escalado por aquele gatilho, THEN THE EscalationEngine SHALL registrar um `EscalationLog`, reatribuir o ticket e enfileirar a notificação no Outbox.
6. THE PriorityEngine SHALL retornar sempre a mesma prioridade para o mesmo par (impacto, urgência). **(Ref. design: Correctness Property 2)**
7. WHEN o impacto ou a urgência aumenta, THE PriorityEngine SHALL nunca reduzir a prioridade derivada. **(Ref. design: Correctness Property 1)**
8. WHEN um ticket requer aprovação, THE ApprovalEngine SHALL criar uma `Approval` no estado PENDING e transicionar o ticket para PENDING_APPROVAL.
9. WHEN um aprovador com autorização decide sobre uma aprovação, THE ApprovalEngine SHALL registrar o estado APPROVED ou REJECTED com a data e a hora da decisão.
10. IF a prioridade de um ticket não possui `SlaRule` associada no momento da criação, THEN THE SlaEngine SHALL rejeitar o cálculo, preservar o ticket sem prazos definidos e sinalizar um erro indicando ausência de regra de SLA.
11. IF um usuário sem autorização de aprovação tenta decidir sobre uma `Approval`, THEN THE ApprovalEngine SHALL rejeitar a decisão, manter a `Approval` no estado PENDING e sinalizar um erro indicando falta de autorização.

### Requirement 13: Histórico auditável e conformidade com LGPD

**User Story:** Como auditor, quero uma trilha imutável de operações sensíveis e conformidade com a LGPD, para que a plataforma seja auditável e proteja dados pessoais.

#### Acceptance Criteria

1. WHEN uma operação sensível é concluída com sucesso, THE AuditService SHALL gravar exatamente um `AuditLog` correspondente com `actor`, `action`, `before`, `after`, `ip` e `timestamp`. **(Ref. design: Correctness Property 10)**
2. IF é tentado um update ou delete sobre um registro de `AuditLog`, THEN THE AuditService SHALL rejeitar a operação e preservar o registro original inalterado.
3. THE JÁ_Helpdesk SHALL manter política de retenção de dados pessoais configurável por tenant e executar rotina de expurgo ou anonimização ao término do período de retenção.
4. WHEN um titular solicita a exportação de seus dados pessoais, THE JÁ_Helpdesk SHALL disponibilizar os dados pessoais do titular em formato estruturado em até 15 dias.
5. WHEN um titular solicita a eliminação de seus dados pessoais, THE JÁ_Helpdesk SHALL anonimizar ou eliminar os dados pessoais do titular em até 15 dias, preservando registros de auditoria exigidos por obrigação legal.
6. THE JÁ_Helpdesk SHALL registrar apenas os dados necessários ao atendimento (minimização) e mascarar PII em logs e telemetria.
7. THE JÁ_Helpdesk SHALL manter base legal registrada para o tratamento de dados pessoais de contatos.

### Requirement 14: Portal de autoatendimento e base de conhecimento

**User Story:** Como solicitante, quero um portal de autoatendimento com base de conhecimento, para que eu resolva dúvidas e acompanhe meus chamados sem contatar um agente.

#### Acceptance Criteria

1. THE JÁ_Helpdesk SHALL disponibilizar um portal de autoatendimento contendo a base de conhecimento (`KbArticle`) e a lista de chamados do solicitante autenticado.
2. WHERE um artigo está marcado como publicado (`published`), THE KnowledgeBaseService SHALL exibi-lo no portal de autoatendimento do tenant, retornando a página de listagem em até 3 segundos.
3. WHERE um artigo não está publicado (rascunho ou arquivado), THE KnowledgeBaseService SHALL ocultá-lo do portal de autoatendimento, não o incluindo em listagens, resultados de busca ou acesso direto por identificador.
4. WHEN um solicitante autenticado acessa o portal, THE JÁ_Helpdesk SHALL exibir somente os chamados e artigos cujo tenant corresponde ao tenant do solicitante.
5. IF um solicitante tenta acessar um artigo ou chamado de outro tenant, THEN THE JÁ_Helpdesk SHALL negar o acesso e exibir uma mensagem indicando que o recurso não foi encontrado, sem revelar a existência do recurso.
6. WHEN um solicitante submete uma busca na base de conhecimento com termo entre 1 e 200 caracteres, THE KnowledgeBaseService SHALL retornar apenas artigos publicados do seu tenant, ordenados por relevância, em até 3 segundos.
7. IF uma busca não retorna nenhum artigo correspondente, THEN THE KnowledgeBaseService SHALL exibir uma mensagem indicando ausência de resultados e manter o termo de busca informado.

### Requirement 15: Relatórios, dashboards e KPIs

**User Story:** Como gestor de atendimento, quero relatórios, dashboards e KPIs, para que eu monitore o desempenho do atendimento.

#### Acceptance Criteria

1. WHEN um usuário abre um relatório ou dashboard, THE JÁ_Helpdesk SHALL apresentar as métricas de contagem de tickets por status, contagem de tickets por fila, tempo de primeira resposta, taxa de violação de SLA e throughput de mensagens por canal em até 5 segundos.
2. THE JÁ_Helpdesk SHALL calcular o tempo de primeira resposta como a diferença, em minutos, entre a data/hora de abertura do ticket e a data/hora da primeira resposta de um atendente.
3. THE JÁ_Helpdesk SHALL calcular a taxa de violação de SLA como o percentual, de 0% a 100% com 2 casas decimais, de tickets cujo tempo de resposta ou resolução excedeu o prazo de SLA definido, sobre o total de tickets do período selecionado.
4. THE JÁ_Helpdesk SHALL calcular o throughput de mensagens por canal como a contagem total de mensagens trocadas em cada canal dentro do período selecionado.
5. WHEN um usuário visualiza relatórios ou dashboards, THE JÁ_Helpdesk SHALL restringir os dados ao `companyId` do usuário autenticado.
6. WHERE o usuário possui escopo restrito, THE JÁ_Helpdesk SHALL limitar os dados exibidos exclusivamente aos recursos cobertos por esse escopo.
7. IF a consulta de dados de um relatório ou dashboard falha ou não retorna dentro de 5 segundos, THEN THE JÁ_Helpdesk SHALL exibir uma mensagem de erro indicando a falha na geração do relatório e preservar a última visualização válida sem alterar os dados subjacentes.
8. IF não existem dados para o período ou filtro selecionado, THEN THE JÁ_Helpdesk SHALL exibir uma indicação de ausência de dados e apresentar cada métrica com valor zero.

### Requirement 16: Automação de tarefas repetitivas

**User Story:** Como administrador de tenant, quero automatizar tarefas repetitivas, para que a equipe reduza o esforço manual.

#### Acceptance Criteria

1. WHERE uma automação está configurada por conta de serviço, THE JÁ_Helpdesk SHALL executá-la exclusivamente sob o tenant da conta de serviço.
2. WHEN uma condição configurada de automação é satisfeita, THE JÁ_Helpdesk SHALL executar a ação automatizada correspondente em até 60 segundos e registrar a operação em auditoria.
3. IF a execução de uma ação automatizada falha, THEN THE JÁ_Helpdesk SHALL registrar a falha em auditoria, não aplicar efeitos parciais e reagendar a execução em até 3 tentativas com backoff.
4. THE JÁ_Helpdesk SHALL suportar no máximo 100 regras de automação ativas por tenant.

### Requirement 17: Integrações via API e webhooks assinados

**User Story:** Como sistema externo, quero receber eventos por webhooks assinados, para que eu reaja com segurança a mudanças no helpdesk.

#### Acceptance Criteria

1. WHEN um evento de webhook configurado ocorre, THE WebhookDispatcher SHALL enfileirar o disparo no Outbox em até 5 segundos, registrando `attempts` igual a 0 e `nextRunAt` igual ao instante atual.
2. WHEN o WebhookDispatcher envia um webhook, THE WebhookDispatcher SHALL assiná-lo com HMAC-SHA256 usando o segredo referenciado por `secretRef` e incluir a assinatura e o timestamp de geração no cabeçalho da requisição.
3. THE JÁ_Helpdesk SHALL armazenar apenas a referência ao segredo (`secretRef`) em `Webhook` e `ChannelAccount`, nunca o valor do segredo. **(Ref. design: Correctness Property 11)**
4. WHEN o WebhookDispatcher envia um webhook, THE WebhookDispatcher SHALL considerar a entrega bem-sucedida somente se o endpoint responder com status de sucesso em até 10 segundos, marcando o evento do Outbox como SENT.
5. IF um efeito externo do Outbox falha por erro transitório (timeout, indisponibilidade do endpoint ou resposta com status de erro que não seja de sucesso), THEN THE JÁ_Helpdesk SHALL incrementar `attempts` em 1 e reagendar `nextRunAt` com backoff exponencial iniciando em 60 segundos e limitado a no máximo 3600 segundos.
6. IF o limite de 5 tentativas do Outbox é atingido sem entrega bem-sucedida, THEN THE JÁ_Helpdesk SHALL marcar o evento como FAILED, preservar o registro do evento e emitir alerta indicando a falha definitiva da entrega.

### Requirement 18: Implantação e gestão de segredos

**User Story:** Como operador de infraestrutura, quero implantar via Docker Compose com prontidão para Kubernetes e segredos externos, para que a plataforma seja portável e segura.

#### Acceptance Criteria

1. THE JÁ_Helpdesk SHALL ser implantável via Docker Compose com os serviços `app`, `worker`, `postgres` e `redis`, disponibilizando todos os 4 serviços em estado de execução saudável.
2. WHEN todos os serviços do Docker Compose são iniciados, THE JÁ_Helpdesk SHALL disponibilizar o serviço `app` para atender requisições em no máximo 60 segundos após o início.
3. IF um dos serviços `app`, `worker`, `postgres` ou `redis` falhar ao iniciar, THEN THE JÁ_Helpdesk SHALL registrar o evento de falha identificando o serviço afetado e impedir que o serviço `app` seja marcado como pronto para atender requisições.
4. THE JÁ_Helpdesk SHALL manter a aplicação stateless, não persistindo estado de sessão ou dados de execução em disco local do serviço `app`, de modo a permitir execução em múltiplas instâncias em Kubernetes sem acoplamento obrigatório.
5. THE JÁ_Helpdesk SHALL obter segredos de variáveis de ambiente ou de secret manager e nunca armazená-los no código-fonte nem em imagens de contêiner. **(Ref. design: Correctness Property 11)**
6. IF um segredo obrigatório estiver ausente ou vazio na inicialização, THEN THE JÁ_Helpdesk SHALL interromper a inicialização do serviço `app` e registrar um evento de erro indicando qual segredo está ausente, sem expor o valor do segredo.
7. WHEN a aplicação inicia, THE JÁ_Helpdesk SHALL aplicar as migrações Prisma pendentes antes de marcar o serviço `app` como pronto para atender requisições.
8. IF a aplicação de uma migração Prisma pendente falhar durante a inicialização, THEN THE JÁ_Helpdesk SHALL interromper a inicialização do serviço `app`, registrar um evento de erro identificando a migração que falhou e preservar o estado do banco de dados sem aplicar migrações parciais adicionais.

### Requirement 19: Observabilidade

**User Story:** Como operador, quero logs estruturados, métricas e health checks, para que eu monitore e diagnostique a plataforma.

#### Acceptance Criteria

1. WHEN uma requisição é processada, THE JÁ_Helpdesk SHALL emitir um log estruturado em JSON contendo `companyId`, `requestId`, `channel`, severidade e timestamp.
2. THE JÁ_Helpdesk SHALL garantir que nenhum valor de segredo (token, senha, chave) apareça em logs ou telemetria, expondo apenas `secretRef`. **(Ref. design: Correctness Property 11)**
3. WHEN o endpoint `/api/health` é chamado, THE JÁ_Helpdesk SHALL reportar em até 2 segundos o estado (healthy/degraded/unhealthy) da aplicação, do banco de dados e da fila, por dependência.
4. IF uma dependência crítica (banco de dados ou fila) está indisponível, THEN THE JÁ_Helpdesk SHALL reportar estado unhealthy no endpoint `/api/health` e retornar status HTTP `503`.
5. THE JÁ_Helpdesk SHALL expor métricas de tickets por status/fila, tempo de primeira resposta, taxa de violação de SLA, throughput por canal e falhas de outbox.
