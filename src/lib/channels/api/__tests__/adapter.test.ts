/**
 * Testes do `ApiAdapter` (task 20.2).
 *
 * Puros — o `TicketService` (`createTicket`/`changeTicketStatus`) é INJETADO
 * como mock, e `Authorization` é exercitado via um mock que lança
 * `AuthorizationError`. NÃO há acesso a DB/rede.
 *
 * Cobertura (Req. 9.1, 9.2, 9.3, 9.5):
 *  - Não autenticado → 401.
 *  - Autenticado, mas não autorizado → 403 (AuthorizationError → ApiForbidden).
 *  - Payload inválido → 422 com campo+motivo, nada persistido.
 *  - Tenant do payload ignorado: o `companyId` do corpo NÃO é usado; o tenant
 *    da conta autenticada é.
 */

import { describe, expect, it, vi } from "vitest";

import {
  API_MAX_ATTACHMENTS,
  ApiForbiddenError,
  ApiUnauthenticatedError,
  ApiValidationError,
  createTicketViaApi,
  updateTicketViaApi,
  type ApiAuthContext,
} from "@/lib/channels/api/adapter";
import { ChannelType, Role, TicketStatus } from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import { AuthorizationError } from "@/lib/rbac/authorization";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTH_COMPANY = "co-authenticated";

const serviceUser: SessionUser = {
  id: "svc-1",
  companyId: AUTH_COMPANY,
  role: Role.INTEGRATION,
  roleAssignments: [],
};

const authedContext: ApiAuthContext = {
  authenticated: true,
  companyId: AUTH_COMPANY,
  user: serviceUser,
};

function okCreate() {
  return vi.fn(async () => ({
    ticketId: "t-1",
    number: 42,
    priority: "MEDIUM",
    status: TicketStatus.OPEN,
    slaResponseDeadline: null,
    slaResolutionDeadline: null,
    slaRuleMissing: false,
  }));
}

const validInput = {
  title: "Servidor fora do ar",
  description: "O serviço de faturamento parou de responder às 14h.",
  createdById: "user-99",
};

// ---------------------------------------------------------------------------
// Req. 9.2 — 401 não autenticado
// ---------------------------------------------------------------------------

describe("createTicketViaApi — autenticação (Req. 9.2)", () => {
  it("lança 401 quando não autenticado", async () => {
    const create = okCreate();
    await expect(
      createTicketViaApi({ authenticated: false }, validInput, {
        createTicket: create,
      }),
    ).rejects.toBeInstanceOf(ApiUnauthenticatedError);
    // Nada persistido: o delegado nunca é chamado.
    expect(create).not.toHaveBeenCalled();
  });

  it("lança 401 quando o contexto de auth é nulo/ausente", async () => {
    const create = okCreate();
    await expect(
      createTicketViaApi(null, validInput, { createTicket: create }),
    ).rejects.toBeInstanceOf(ApiUnauthenticatedError);
    await expect(
      createTicketViaApi(undefined, validInput, { createTicket: create }),
    ).rejects.toBeInstanceOf(ApiUnauthenticatedError);
    expect(create).not.toHaveBeenCalled();
  });

  it("o erro 401 carrega status=401", async () => {
    try {
      await createTicketViaApi({ authenticated: false }, validInput);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnauthenticatedError);
      expect((err as ApiUnauthenticatedError).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Req. 9.3 — 403 autenticado mas não autorizado
// ---------------------------------------------------------------------------

describe("createTicketViaApi — autorização (Req. 9.3)", () => {
  it("traduz AuthorizationError do TicketService em 403", async () => {
    // O delegado (createTicket) chama Authorization.assert internamente; aqui
    // simulamos a negação lançando AuthorizationError.
    const create = vi.fn(async () => {
      throw new AuthorizationError();
    });
    await expect(
      createTicketViaApi(authedContext, validInput, { createTicket: create }),
    ).rejects.toBeInstanceOf(ApiForbiddenError);
  });

  it("o erro 403 carrega status=403", async () => {
    const create = vi.fn(async () => {
      throw new AuthorizationError();
    });
    try {
      await createTicketViaApi(authedContext, validInput, {
        createTicket: create,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiForbiddenError);
      expect((err as ApiForbiddenError).status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Req. 9.4, 9.5 — 422 payload inválido
// ---------------------------------------------------------------------------

describe("createTicketViaApi — validação (Req. 9.4, 9.5)", () => {
  it("título vazio → 422 com campo+motivo, nada persistido", async () => {
    const create = okCreate();
    try {
      await createTicketViaApi(
        authedContext,
        { ...validInput, title: "" },
        { createTicket: create },
      );
      throw new Error("deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiValidationError);
      const e = err as ApiValidationError;
      expect(e.status).toBe(422);
      expect(e.fieldErrors.some((f) => f.field === "title")).toBe(true);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("descrição acima de 5.000 → 422", async () => {
    const create = okCreate();
    await expect(
      createTicketViaApi(
        authedContext,
        { ...validInput, description: "x".repeat(5001) },
        { createTicket: create },
      ),
    ).rejects.toBeInstanceOf(ApiValidationError);
    expect(create).not.toHaveBeenCalled();
  });

  it("mais de 50 anexos → 422", async () => {
    const create = okCreate();
    const attachments = Array.from(
      { length: API_MAX_ATTACHMENTS + 1 },
      (_, i) => ({ id: `att-${i}` }),
    );
    try {
      await createTicketViaApi(
        authedContext,
        { ...validInput, attachments },
        { createTicket: create },
      );
      throw new Error("deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiValidationError);
      expect(
        (err as ApiValidationError).fieldErrors.some((f) =>
          f.field.startsWith("attachments"),
        ),
      ).toBe(true);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("exatamente 50 anexos é aceito", async () => {
    const create = okCreate();
    const attachments = Array.from({ length: API_MAX_ATTACHMENTS }, (_, i) => ({
      id: `att-${i}`,
    }));
    await createTicketViaApi(
      authedContext,
      { ...validInput, attachments },
      { createTicket: create },
    );
    expect(create).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Req. 9.1 — tenant do payload ignorado
// ---------------------------------------------------------------------------

describe("createTicketViaApi — tenant do payload ignorado (Req. 9.1)", () => {
  it("usa o companyId da conta autenticada, não o do corpo", async () => {
    const create = okCreate();
    await createTicketViaApi(
      authedContext,
      // Um companyId "malicioso" no corpo — deve ser IGNORADO.
      { ...validInput, companyId: "co-atacante" } as never,
      { createTicket: create },
    );
    expect(create).toHaveBeenCalledOnce();
    const [user, companyId, payload] = create.mock.calls[0];
    // Tenant derivado do servidor.
    expect(companyId).toBe(AUTH_COMPANY);
    expect(user).toBe(serviceUser);
    // O payload repassado ao TicketService não contém companyId.
    expect(payload).not.toHaveProperty("companyId");
    // Origem marcada como API.
    expect(payload.origin).toBe(ChannelType.API);
  });

  it("propaga o resultado do TicketService (número/prioridade/SLA reutilizados)", async () => {
    const create = okCreate();
    const result = await createTicketViaApi(authedContext, validInput, {
      createTicket: create,
    });
    expect(result.ticketId).toBe("t-1");
    expect(result.number).toBe(42);
    expect(result.status).toBe(TicketStatus.OPEN);
  });
});

// ---------------------------------------------------------------------------
// updateTicketViaApi
// ---------------------------------------------------------------------------

describe("updateTicketViaApi", () => {
  it("401 quando não autenticado", async () => {
    const change = vi.fn();
    await expect(
      updateTicketViaApi(
        { authenticated: false },
        { ticketId: "t-1", status: TicketStatus.RESOLVED },
        { changeTicketStatus: change },
      ),
    ).rejects.toBeInstanceOf(ApiUnauthenticatedError);
    expect(change).not.toHaveBeenCalled();
  });

  it("422 para status inválido", async () => {
    const change = vi.fn();
    await expect(
      updateTicketViaApi(
        authedContext,
        { ticketId: "t-1", status: "NAO_EXISTE" },
        { changeTicketStatus: change },
      ),
    ).rejects.toBeInstanceOf(ApiValidationError);
    expect(change).not.toHaveBeenCalled();
  });

  it("403 quando o TicketService nega autorização", async () => {
    const change = vi.fn(async () => {
      throw new AuthorizationError();
    });
    await expect(
      updateTicketViaApi(
        authedContext,
        { ticketId: "t-1", status: TicketStatus.RESOLVED },
        { changeTicketStatus: change },
      ),
    ).rejects.toBeInstanceOf(ApiForbiddenError);
  });

  it("delega com o tenant autenticado e ignora tenant do corpo", async () => {
    const change = vi.fn(async () => ({
      ticketId: "t-1",
      status: TicketStatus.RESOLVED,
    }));
    await updateTicketViaApi(
      authedContext,
      {
        ticketId: "t-1",
        status: TicketStatus.RESOLVED,
        companyId: "co-atacante",
      } as never,
      { changeTicketStatus: change },
    );
    const [user, companyId, ticketId, status] = change.mock.calls[0];
    expect(companyId).toBe(AUTH_COMPANY);
    expect(user).toBe(serviceUser);
    expect(ticketId).toBe("t-1");
    expect(status).toBe(TicketStatus.RESOLVED);
  });
});
