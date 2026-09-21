# 0002 — Outbox transacional para efeitos externos

- **Status:** Aceito
- **Requisitos relacionados:** 17.1, 17.4, 17.5, 17.6
- **Fonte:** `.kiro/specs/helpdesk-omnichannel/design.md` (seções "Outbox" e "Workers")

## Contexto

Muitas operações precisam alterar o estado do banco **e** disparar um efeito externo: enviar mensagem pela Cloud API do WhatsApp, notificar por e-mail, chamar um webhook de saída. Se o efeito externo for disparado de forma síncrona dentro do request, uma falha parcial pode deixar o sistema inconsistente (estado gravado mas efeito não enviado, ou vice-versa), além de acoplar a latência do request a serviços externos instáveis.

## Decisão

Adotar o padrão **Transactional Outbox**: na **mesma transação** que altera o estado de negócio, gravar um registro `OutboxEvent` (PENDING) descrevendo o efeito desejado. Um **worker** separado lê os eventos pendentes e executa os efeitos externos de forma **idempotente**, com **backoff exponencial** (60s → 3600s) e limite de tentativas; após o limite marca `FAILED` e emite alerta. A entrega só é `SENT` mediante resposta de sucesso do destino dentro do timeout.

Toda saída externa (WhatsApp `send`, webhooks assinados por HMAC, notificações) passa pelo outbox. Segredos de assinatura vêm de `secretRef`, nunca do registro.

## Consequências

**Positivas**
- Atomicidade entre estado e intenção de efeito: ou ambos são registrados, ou nenhum.
- Resiliência a falhas transitórias via retry/backoff, sem perder eventos.
- Requests rápidos: o trabalho pesado sai do caminho síncrono.
- Idempotência evita efeitos duplicados em reprocessamento.

**Negativas / trade-offs**
- Introduz **eventual consistency**: o efeito externo ocorre pouco depois do commit, não instantaneamente.
- Requer um processo worker adicional e monitoramento do backlog/FAILED.
- Handlers de efeito precisam ser projetados como idempotentes.
