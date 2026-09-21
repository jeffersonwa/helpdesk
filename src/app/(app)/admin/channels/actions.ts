"use server";

/**
 * Server Actions de Canais (tarefa 33.1) — registro/edição de `ChannelAccount`.
 *
 * SEGURANÇA (backend-first):
 *  - `companyId` derivado da sessão do servidor via {@link currentSessionUser}.
 *  - A permissão `channel.configure` é aplicada no backend AQUI via
 *    `Authorization.assert` ANTES de qualquer efeito (não há um `channels/service`
 *    dedicado; o gate é feito nesta action, seguindo o mesmo padrão dos demais
 *    serviços). Ocultar o formulário na UI é apenas conveniência. (Req. 2.1, 2.2)
 *  - `secretRef` é SEMPRE uma REFERÊNCIA (ex.: nome de variável de ambiente ou
 *    caminho no secret manager) — NUNCA o valor do segredo. Nada de segredo é
 *    persistido no banco/código. (Req. 6.x, 17.3, 19.2)
 *  - Toda escrita é escopada por `companyId` (edição só atinge contas do tenant).
 *
 * _Requisitos: 2.1, 2.2, 1.3_
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentSessionUser } from "@/lib/rbac/session-user";
import { Authorization } from "@/lib/rbac/authorization";
import { AuthorizationError } from "@/lib/rbac/types";
import { ChannelProvider, ChannelType } from "@/lib/domain/enums";

export type ActionResult = { ok: true } | { ok: false; error: string };

const DENIED = "Você não tem permissão para configurar canais (channel.configure).";

/**
 * Schema de registro/edição de canal. NÃO aceita `companyId` (derivado do
 * servidor). `secretRef` é uma referência não-vazia; nunca um segredo em claro.
 */
const channelSchema = z.object({
  label: z.string().trim().min(1, "rótulo é obrigatório").max(120),
  type: z.enum(ChannelType),
  provider: z.enum(ChannelProvider),
  externalId: z.string().trim().max(200).optional(),
  secretRef: z.string().trim().min(1, "referência de segredo é obrigatória").max(200),
  active: z.boolean().optional(),
});

export type ChannelInput = z.input<typeof channelSchema>;

/** Registra um novo `ChannelAccount` no tenant da sessão. */
export async function createChannelAction(input: ChannelInput): Promise<ActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };

  const parsed = channelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };
  }
  const data = parsed.data;

  try {
    // Autorização no backend ANTES de qualquer efeito (operação de plataforma).
    Authorization.assert(user, "channel.configure", {
      companyId: user.companyId,
      type: "channel",
    });

    await prisma.channelAccount.create({
      data: {
        companyId: user.companyId,
        label: data.label,
        type: data.type,
        provider: data.provider,
        externalId: data.externalId || null,
        secretRef: data.secretRef, // referência, nunca o segredo em si
        active: data.active ?? true,
      },
    });
    revalidatePath("/admin/channels");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, error: DENIED };
    return { ok: false, error: "Erro ao registrar canal." };
  }
}

/** Edita um `ChannelAccount` existente do tenant (escopo por companyId). */
export async function updateChannelAction(
  id: string,
  input: ChannelInput,
): Promise<ActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };

  const parsed = channelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };
  }
  const data = parsed.data;

  try {
    Authorization.assert(user, "channel.configure", {
      companyId: user.companyId,
      type: "channel",
      id,
    });

    // updateMany escopado por { id, companyId } → nunca cruza tenant.
    const res = await prisma.channelAccount.updateMany({
      where: { id, companyId: user.companyId },
      data: {
        label: data.label,
        type: data.type,
        provider: data.provider,
        externalId: data.externalId || null,
        secretRef: data.secretRef,
        active: data.active ?? true,
      },
    });
    if (res.count === 0) return { ok: false, error: "Canal não encontrado." };
    revalidatePath("/admin/channels");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, error: DENIED };
    return { ok: false, error: "Erro ao atualizar canal." };
  }
}
