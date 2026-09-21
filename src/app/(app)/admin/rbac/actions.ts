"use server";

/**
 * Server Actions de RBAC (tarefa 33.1) — criação de papel customizado e
 * atribuição de papel a usuário.
 *
 * SEGURANÇA (backend-first):
 *  - `companyId` derivado da sessão do servidor via {@link currentSessionUser}.
 *  - `rbac.manage` é aplicada no backend pelo `rbac/service` (que chama
 *    `Authorization.assert`) ANTES de qualquer efeito. A UI apenas oculta o
 *    formulário para não-admins — o gate real é o serviço. (Req. 2.1, 2.2, 3.1)
 *
 * _Requisitos: 3.1, 3.4, 2.1, 2.2, 1.3_
 */

import { revalidatePath } from "next/cache";
import { currentSessionUser } from "@/lib/rbac/session-user";
import { AuthorizationError } from "@/lib/rbac/types";
import { ScopeLevel } from "@/lib/domain/enums";
import {
  createRoleDef,
  assignRole,
  defaultRbacClient,
  RbacValidationError,
} from "@/lib/rbac/service";

export type ActionResult = { ok: true } | { ok: false; error: string };

const DENIED = "Você não tem permissão para gerenciar papéis (rbac.manage).";

/**
 * Cria um `RoleDef` customizado no tenant da sessão, com nome + permissões
 * selecionadas do catálogo. Escopos-template opcionais (aqui, nível TENANT por
 * padrão quando informado).
 */
export async function createRoleAction(input: {
  name: string;
  permissions: string[];
  tenantScope?: boolean;
}): Promise<ActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };

  try {
    await createRoleDef(defaultRbacClient(), user, user.companyId, {
      name: input.name,
      permissions: input.permissions,
      scopes: input.tenantScope ? [{ level: ScopeLevel.TENANT, refId: null }] : [],
    });
    revalidatePath("/admin/rbac");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, error: DENIED };
    if (err instanceof RbacValidationError) return { ok: false, error: err.message };
    return { ok: false, error: "Erro ao criar papel." };
  }
}

/**
 * Atribui um `RoleDef` a um usuário do tenant, com escopo TENANT (cobre todo o
 * tenant). A duplicação de atribuição no mesmo escopo é rejeitada pelo serviço.
 */
export async function assignRoleAction(input: {
  userId: string;
  roleDefId: string;
}): Promise<ActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };

  try {
    await assignRole(defaultRbacClient(), user, user.companyId, {
      userId: input.userId,
      roleDefId: input.roleDefId,
      scopes: [{ level: ScopeLevel.TENANT, refId: null }],
    });
    revalidatePath("/admin/rbac");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, error: DENIED };
    if (err instanceof RbacValidationError) return { ok: false, error: err.message };
    return { ok: false, error: "Erro ao atribuir papel." };
  }
}
