import { Priority } from "@prisma/client";
import { prisma } from "./prisma";

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

export function slaStatus(deadline: Date | null): "ok" | "warning" | "breached" {
  if (!deadline) return "ok";
  const now = new Date();
  const diff = deadline.getTime() - now.getTime();
  const hours = diff / (1000 * 60 * 60);
  if (diff < 0) return "breached";
  if (hours < 2) return "warning";
  return "ok";
}
