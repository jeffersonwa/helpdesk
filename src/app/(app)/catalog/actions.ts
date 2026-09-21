"use server";

/**
 * Server Actions do Catálogo de serviços de TI (tarefa 33.1).
 *
 * SEGURANÇA:
 *  - `companyId` derivado da sessão do servidor via {@link currentSessionUser}
 *    (nunca do form). (Req. 1.1–1.3)
 *  - Autorização (`catalog.manage`) aplicada no backend por `org/service`
 *    (`Authorization.assert`) ANTES de qualquer efeito. (Req. 2.1, 2.2)
 *  - Validação hierárquica (nome 1–120, tenant do pai, unicidade) no serviço.
 *
 * Estrutura: CatalogService → Category → Subcategory → CategoryItem.
 *
 * _Requisitos: 11.1, 11.2, 11.7, 2.1, 2.2, 1.3_
 */

import { revalidatePath } from "next/cache";
import { currentSessionUser } from "@/lib/rbac/session-user";
import { AuthorizationError } from "@/lib/rbac/types";
import {
  createCatalogService,
  createCategory,
  createSubcategory,
  createCategoryItem,
  OrgValidationError,
} from "@/lib/org/service";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Traduz exceções conhecidas dos serviços em mensagens amigáveis. */
function toError(err: unknown, denied: string): ActionResult {
  if (err instanceof AuthorizationError) return { ok: false, error: denied };
  if (err instanceof OrgValidationError) return { ok: false, error: err.message };
  return { ok: false, error: "Erro ao salvar entrada do catálogo." };
}

const DENIED = "Você não tem permissão para gerenciar o catálogo.";

export async function createCatalogServiceAction(input: { name: string }): Promise<ActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };
  try {
    await createCatalogService(user, user.companyId, { name: input.name });
    revalidatePath("/catalog");
    return { ok: true };
  } catch (err) {
    return toError(err, DENIED);
  }
}

export async function createCategoryAction(input: {
  name: string;
  serviceId?: string;
}): Promise<ActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };
  try {
    await createCategory(user, user.companyId, {
      name: input.name,
      serviceId: input.serviceId || null,
    });
    revalidatePath("/catalog");
    return { ok: true };
  } catch (err) {
    return toError(err, DENIED);
  }
}

export async function createSubcategoryAction(input: {
  name: string;
  categoryId: string;
}): Promise<ActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };
  try {
    await createSubcategory(user, user.companyId, {
      name: input.name,
      categoryId: input.categoryId,
    });
    revalidatePath("/catalog");
    return { ok: true };
  } catch (err) {
    return toError(err, DENIED);
  }
}

export async function createCategoryItemAction(input: {
  name: string;
  subcategoryId: string;
}): Promise<ActionResult> {
  const user = await currentSessionUser();
  if (!user) return { ok: false, error: "Sessão inválida" };
  try {
    await createCategoryItem(user, user.companyId, {
      name: input.name,
      subcategoryId: input.subcategoryId,
    });
    revalidatePath("/catalog");
    return { ok: true };
  } catch (err) {
    return toError(err, DENIED);
  }
}
