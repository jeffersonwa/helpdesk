/**
 * PriorityEngine — núcleo puro.
 *
 * Deriva a `Priority` de um ticket a partir da matriz impacto × urgência
 * (padrão ITIL) definida no design
 * (`.kiro/specs/helpdesk-omnichannel/design.md`, seção "Motor de SLA e
 * Escalonamento" → "Cálculo de prioridade (matriz impacto × urgência)").
 *
 * A prioridade NÃO é escolhida diretamente: é sempre derivada. Esta função é
 * pura, determinística e sem I/O.
 *
 * _Requisitos: 4.7, 12.6, 12.7_
 */

import { Impact, Priority, Urgency } from "@/lib/domain/enums";

/**
 * Matriz de derivação impacto × urgência, exatamente conforme o design.
 *
 *   HIGH   × { HIGH: CRITICAL, MEDIUM: HIGH,   LOW: MEDIUM }
 *   MEDIUM × { HIGH: HIGH,     MEDIUM: MEDIUM, LOW: LOW }
 *   LOW    × { HIGH: MEDIUM,   MEDIUM: LOW,    LOW: LOW }
 */
const PRIORITY_MATRIX: Record<Impact, Record<Urgency, Priority>> = {
  [Impact.HIGH]: {
    [Urgency.HIGH]: Priority.CRITICAL,
    [Urgency.MEDIUM]: Priority.HIGH,
    [Urgency.LOW]: Priority.MEDIUM,
  },
  [Impact.MEDIUM]: {
    [Urgency.HIGH]: Priority.HIGH,
    [Urgency.MEDIUM]: Priority.MEDIUM,
    [Urgency.LOW]: Priority.LOW,
  },
  [Impact.LOW]: {
    [Urgency.HIGH]: Priority.MEDIUM,
    [Urgency.MEDIUM]: Priority.LOW,
    [Urgency.LOW]: Priority.LOW,
  },
};

/**
 * Deriva a prioridade a partir do impacto e da urgência.
 *
 * Função pura e determinística: o mesmo par `(impact, urgency)` sempre retorna
 * a mesma `Priority`.
 */
export function derivePriority(impact: Impact, urgency: Urgency): Priority {
  return PRIORITY_MATRIX[impact][urgency];
}
