# 0003 — Motores puros (prioridade/SLA/escalonamento) separados de I/O

- **Status:** Aceito
- **Requisitos relacionados:** 12.1, 12.4, 12.6, 12.7
- **Fonte:** `.kiro/specs/helpdesk-omnichannel/design.md` (seções "Motores de domínio" e "Correctness Properties")

## Contexto

As regras centrais do helpdesk — derivação de prioridade (impacto × urgência), cálculo de prazos e status de SLA, e seleção de escalonamentos — são a parte mais sensível a correção. Se essa lógica for escrita entrelaçada com Prisma, HTTP e relógio do sistema, fica difícil de testar de forma exaustiva e propensa a regressões sutis.

## Decisão

Implementar essas regras como **funções puras e determinísticas**, sem I/O e sem dependência de estado global: `derivePriority(impact, urgency)`, `calcSla(rule, createdAt)` / `slaStatus(deadline, now)` e `selectEscalations(ticket, rules, now)`. Todos os dados de que dependem (incluindo o "agora" e predicados como "já escalado") são **injetados** como parâmetros a partir de um snapshot. A camada de serviço/worker faz o wiring com o banco e o tempo real.

Essas funções são cobertas por **testes baseados em propriedades** (`fast-check`) que validam as propriedades de correção do design (monotonicidade e determinismo da prioridade, ordenação e coerência de SLA, uso único por gatilho no escalonamento).

## Consequências

**Positivas**
- Testabilidade máxima: propriedades e casos de borda sem banco nem mocks de I/O.
- Determinismo: mesma entrada → mesma saída, facilitando raciocínio e reprodução.
- Reuso: as mesmas funções servem a requests, workers e relatórios.

**Negativas / trade-offs**
- Exige disciplina para montar o snapshot na borda e injetar `now`/predicados.
- Alguma duplicação aparente entre o formato do snapshot e o modelo persistido, compensada pela clareza e isolamento.
