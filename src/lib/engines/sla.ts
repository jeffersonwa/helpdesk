/**
 * SlaEngine — núcleo puro.
 *
 * Funções puras de cálculo de prazos e status de SLA, exatamente conforme o
 * design (`.kiro/specs/helpdesk-omnichannel/design.md`, seção "Motor de SLA e
 * Escalonamento" → pseudocódigos `calcSla` / `slaStatus`).
 *
 * Este módulo é DELIBERADAMENTE livre de I/O e de dependências do Prisma, de
 * modo que possa ser importado por testes (e por outros motores puros) sem
 * exigir client gerado nem `DATABASE_URL`. O helper DB-backed
 * `calcSlaDeadline` permanece em `src/lib/sla.ts`, que reexporta estas funções
 * para os chamadores existentes.
 *
 * _Requisitos: 12.1, 12.2, 12.3_
 */

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * Calcula os prazos de resposta e resolução de SLA a partir de uma regra e do
 * instante de criação. Função pura: sem I/O, sem `new Date()`, não muta
 * `createdAt`.
 *
 * `responseDeadline`   = createdAt + rule.responseHours horas
 * `resolutionDeadline` = createdAt + rule.resolutionHours horas
 *
 * _Requisitos: 12.1, 12.2_
 */
export function calcSla(
  rule: { responseHours: number; resolutionHours: number },
  createdAt: Date,
): { responseDeadline: Date; resolutionDeadline: Date } {
  const base = createdAt.getTime();
  return {
    responseDeadline: new Date(base + rule.responseHours * MS_PER_HOUR),
    resolutionDeadline: new Date(base + rule.resolutionHours * MS_PER_HOUR),
  };
}

/**
 * Determina o status de um prazo de SLA relativo a um instante `now`.
 *
 * Semântica (conforme design):
 *  - `deadline === null` → "ok"
 *  - `deadline < now`    → "breached"
 *  - restando < 2h       → "warning"
 *  - caso contrário      → "ok"
 *
 * `now` é injetável para testabilidade; por padrão usa o relógio do sistema,
 * preservando os chamadores existentes que passam apenas `deadline`.
 *
 * _Requisitos: 12.3_
 */
export function slaStatus(
  deadline: Date | null,
  now: Date = new Date(),
): "ok" | "warning" | "breached" {
  if (!deadline) return "ok";
  const diff = deadline.getTime() - now.getTime();
  if (diff < 0) return "breached";
  const hours = diff / MS_PER_HOUR;
  if (hours < 2) return "warning";
  return "ok";
}
