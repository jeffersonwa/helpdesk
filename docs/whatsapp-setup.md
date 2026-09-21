# Conectando o WhatsApp (Meta Cloud API oficial)

> Tarefa 37.1 · Requisitos 6.1, 6.3, 6.5, 18.5 · Fonte: `.kiro/specs/helpdesk-omnichannel/design.md` (seções "WhatsApp" e "Implantação").

Este guia mostra como conectar credenciais **reais** da **Meta WhatsApp Business Cloud API** ao JÁ Helpdesk.

## Restrição inviolável

O JÁ Helpdesk fala com o WhatsApp **exclusivamente** pela **Cloud API oficial da Meta** (domínio `graph.facebook.com`). É **proibido** e **não suportado**: WhatsApp Web, QR Code, scraping, automação de navegador e bibliotecas não oficiais. Qualquer tentativa por via não oficial é **rejeitada** pelo adaptador, sem chamada externa, e registrada em auditoria (Req. 6.1, 6.2).

## Visão geral do fluxo

1. Criar um **App** no Meta for Developers e adicionar o produto **WhatsApp**.
2. Obter o **`phone_number_id`** e o **WABA ID** (WhatsApp Business Account).
3. Definir o **webhook** (callback URL + `verify_token`) e assinar os campos de mensagens.
4. Copiar o **App Secret** (valida a assinatura `X-Hub-Signature-256`).
5. Gerar um **access token permanente** (System User).
6. Mapear tudo para variáveis de ambiente / `secretRef`.

---

## 1. Criar o App e adicionar o WhatsApp

1. Acesse o painel de desenvolvedores da Meta e crie um **App** (tipo "Business").
2. No App, adicione o produto **WhatsApp**. Isso cria uma **WhatsApp Business Account (WABA)** de teste e um número de teste.
3. Para produção, associe/registre o **número de telefone oficial** da empresa à WABA e conclua a verificação do negócio exigida pela Meta.

> Um mesmo número oficial atende **múltiplos agentes** no JÁ Helpdesk — o roteamento é feito internamente por conversa/ticket, não por dispositivo.

## 2. Obter `phone_number_id` e WABA ID

- No painel do produto WhatsApp → **API Setup**, você verá:
  - **Phone number ID** → mapeia para `WHATSAPP_PHONE_NUMBER_ID`.
  - **WhatsApp Business Account ID (WABA ID)** → usado na administração de templates.
- O `phone_number_id` é o identificador usado pela Cloud API para **enviar** mensagens e é gravado no `ChannelAccount.externalId` do tenant.

## 3. Configurar o webhook

O JÁ Helpdesk expõe o endpoint de webhook em:

```
https://csc.nitecnologia.tec.br/api/webhooks/whatsapp
```

Na configuração de **Webhooks** do produto WhatsApp:

1. **Callback URL:** `https://csc.nitecnologia.tec.br/api/webhooks/whatsapp`
2. **Verify token:** um valor **que você define** e coloca em `WHATSAPP_VERIFY_TOKEN`.
   - Ao salvar, a Meta faz um **handshake GET** com `hub.mode`, `hub.verify_token` e `hub.challenge`.
   - O adaptador retorna o `hub.challenge` **somente** se o `hub.verify_token` conferir exatamente com o segredo configurado; caso contrário responde **403** (Req. 6.3, 6.4).
3. **Assinar os campos** (subscribe) de **`messages`** para receber mensagens e status.

### Assinatura HMAC dos eventos (`X-Hub-Signature-256`)

- Cada evento **POST** chega com o cabeçalho **`X-Hub-Signature-256`**.
- O adaptador valida esse cabeçalho via **HMAC SHA-256** do corpo cru, usando o **App Secret**, com **comparação em tempo constante**, **antes** de processar qualquer parte do payload (Req. 6.5).
- Se a assinatura faltar ou não conferir, o evento é **descartado** sem persistir nada e sem gerar `Message` (Req. 6.6), com resposta **401/403**.

## 4. App Secret

- Em **App Settings → Basic**, copie o **App Secret**.
- Mapeie para `WHATSAPP_APP_SECRET`. É o segredo que valida a assinatura dos webhooks (item anterior).

## 5. Access token permanente

O token de teste expira. Para produção, gere um **token permanente** via **System User**:

1. No Business Manager, crie um **System User** (Admin).
2. Atribua o **App** e a **WABA** como ativos ao System User.
3. Gere um token com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`.
4. Mapeie para `WHATSAPP_ACCESS_TOKEN`.

## 6. Variáveis de ambiente (mapeamento)

Preencha no ambiente (nunca no código — Req. 18.5). Veja também `.env.example`.

| Variável | O que é | Onde obter |
| --- | --- | --- |
| `CHANNEL_WHATSAPP_PROVIDER` | Provider ativo. Use `whatsapp_cloud` em produção. | Fixo (config). |
| `WHATSAPP_PHONE_NUMBER_ID` | `phone_number_id` do número. | API Setup do produto WhatsApp. |
| `WHATSAPP_APP_SECRET` | App Secret (valida `X-Hub-Signature-256`). | App Settings → Basic. |
| `WHATSAPP_VERIFY_TOKEN` | Token do handshake do webhook (você define). | Você define e reusa na Meta. |
| `WHATSAPP_ACCESS_TOKEN` | Token permanente da Cloud API. | System User (Business Manager). |

> **Onde os segredos ficam:** em variáveis de ambiente ou secret manager (Vault, AWS/GCP Secrets Manager, K8s Secret / External Secrets). O modelo de dados guarda apenas uma **`secretRef`** (referência), **nunca o valor** do segredo (Req. 18.5, Correctness Property 11). Nenhum segredo aparece em código, imagem de contêiner ou logs.

## Provider MOCK (somente desenvolvimento)

Para desenvolvimento local sem credenciais reais, use:

```
CHANNEL_WHATSAPP_PROVIDER=whatsapp_mock
```

- O `WhatsAppMockAdapter` implementa a **mesma interface** do adaptador real, **sem** chamadas externas.
- Ele é **bloqueado em produção**: quando `NODE_ENV=production`, habilitar o MOCK falha com erro claro. Em produção use sempre `whatsapp_cloud`.

## Janela de 24 horas e templates

O WhatsApp restringe mensagens iniciadas pela empresa fora da **janela de atendimento de 24h** (contada a partir da última mensagem do cliente):

- **Dentro da janela:** envio de **formato livre** é permitido.
- **Fora da janela:** o envio só é aceito com um **`templateName`** (template de mensagem previamente **aprovado** pela Meta). Sem `templateName`, o adaptador **rejeita o envio antes** de chamar a Cloud API (Req. 6.8, Correctness Property 9).
- Gerencie e submeta seus **templates** para aprovação no Business Manager (associados à WABA).

## Mídia

- Anexos/mídia usam os **endpoints de mídia** da Cloud API. Os binários vão para **object storage** (S3 compatível) e o `Message.mediaUrl` guarda a **referência** — nada é gravado no disco local do `app` (stateless, Req. 18.4).
- Falha ao baixar/enviar uma mídia sinaliza pendência **sem** interromper o processamento das demais mensagens.

## Checklist de validação

- [ ] Handshake do webhook retorna o `challenge` (verify token correto) e **403** quando incorreto.
- [ ] Evento com `X-Hub-Signature-256` válido é processado; assinatura ausente/inválida é **descartada** (401/403), sem criar `Message`.
- [ ] Envio dentro da janela funciona em formato livre; fora da janela exige `templateName`.
- [ ] Todos os segredos vêm de env/secret manager; nenhum valor aparece em logs (apenas `secretRef`).
