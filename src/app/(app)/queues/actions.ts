"use server";

/**
 * Server Actions das Filas (tarefa 33.1).
 *
 * SEGURANÇA (aplicada no BACKEND, independentemente da UI):
 *  - O `companyId` é SEMPRE derivado da sessão do servidor via
 *    {@link currentSessionUser} (nunca do corpo/form). (Req. 1.1–1.3)
 *  - A autorização é aplicada pelo próprio serviço (`org/service`), que chama
 *    `Authorization.assert(user, "queue.manage", ...)` ANTES de qualquer efeito.
 *    Aqui apenas materializamos o `SessionUser` (com `roleAssignments` carregadas
 *    do banco) e delegamos. Esconder o formulário no frontend é só UX. (Req. 2.1, 2.2)
 *
 * _Requisitos: 11.1, 2.1, 2.2, 1.3_
 */

import { revalidatePath } from "next/cache";
import { currentSessionUser } from "@/lib/rbac/session-user";
import { AuthorizationError } from "@/lib/rbac/types";
import { createQueue, OrgValidationError } from "@/lib/org/service";

/** Resultado padrão de uma Server Action de formulário. */
export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Cria uma fila no tenant da sessão. Autorização e validação são feitas no
 * backend (`org/service.createQueue`). Retorna erro amigável em falha.
 */
export async function createQueueAction(input: {
  name: string;
  isDefault?: boolean;
}): Promise<ActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };

  try {
    await createQueue(user, user.companyId, {
      name: input.name,
      isDefault: input.isDefault ?? false,
    });
    revalidatePath("/queues");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: "Você não tem permissão para gerenciar filas." };
    }
    if (err instanceof OrgValidationError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "Erro ao criar fila." };
  }
}
