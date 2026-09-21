# 0001 — Padrão provider/adapter de canais

- **Status:** Aceito
- **Requisitos relacionados:** 5.1, 5.7
- **Fonte:** `.kiro/specs/helpdesk-omnichannel/design.md` (seção "Canais")

## Contexto

O JÁ Helpdesk é omnichannel: recebe e envia mensagens por WhatsApp (Cloud API), e-mail, formulário público e API. Cada canal tem transporte, autenticação e formato de payload distintos. Sem uma abstração comum, a lógica de ingestão, criação de conversa/ticket e envio ficaria acoplada aos detalhes de cada canal, dificultando adicionar novos canais e testar de forma isolada.

## Decisão

Definir uma interface única **`ChannelAdapter`** com as operações `capabilities`, `verifyInbound`, `parseInbound` e `send`, e um **registro de providers** que seleciona a implementação por configuração (ex.: `CHANNEL_WHATSAPP_PROVIDER`). Cada canal implementa o adapter e normaliza entradas/saídas para os tipos comuns `InboundMessage` / `SendResult`. O roteador de ingestão e os serviços de domínio dependem apenas da interface, nunca de um provider concreto.

Isso permite implementações intercambiáveis — por exemplo, um `WhatsAppCloudAdapter` (oficial) e um `WhatsAppMockAdapter` (desenvolvimento) — validadas por uma suíte de contrato compartilhada (Correctness Property 12: intercambialidade dos adapters).

## Consequências

**Positivas**
- Novos canais entram implementando a interface, sem tocar no núcleo.
- Testabilidade: adapters são exercitados pela mesma suíte de contrato; o mock roda sem I/O externo.
- Seleção por configuração desacopla ambiente (dev/prod) do código.

**Negativas / trade-offs**
- A interface precisa ser genérica o suficiente para cobrir capacidades heterogêneas (ex.: janela de 24h só existe no WhatsApp), exigindo `capabilities` para expressar diferenças.
- Uma abstração comum pode esconder particularidades; mitigado por `capabilities` e por testes específicos por adapter.
