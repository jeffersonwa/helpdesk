import { Priority } from "@prisma/client";
import { prisma } from "./prisma";

// Funções puras do SlaEngine vivem em `@/lib/engines/sla` (livre de Prisma).
// São reexportadas aqui para preservar os chamadores existentes de `@/lib/sla`.
export { calcSla, slaStatus } from "./engines/sla";

const defaultHours: Record<Priority, { response: number; resolution: number }> = {
  CRITICAL: { response: 1, resolution: 4 },
  HIGH:     { response: 4, resolution: 8 },
  MEDIUM:   { response: 8, resolution: 24 },
  LOW:      { response: 24, resolution: 72 },
};

export async function calcSlaDeadline(companyId: string, priority: Priority): Promise<Date> {
  const rule = await prisma.slaRule.findUnique({
    where: { companyId_priority: { companyId, priority } },
  });

  const hours = rule?.resolutionHours ?? defaultHours[priority].resolution;
  const deadline = new Date();
  deadline.setHours(deadline.getHours() + hours);
  return deadline;
}
