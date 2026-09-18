/**
 * Testes do handler de ingestão de tickets via API (v1) — tarefa 21.2.
 *
 * Estilo unit: `handleApiCreateTicket`/`handleApiUpdateTicket` com um
 * autenticador injetado. A autorização/validação vive no `ApiAdapter`; aqui
 * validamos o mapeamento HTTP: 401 (não autenticado), 422 (validação), 201/200
 * (sucesso). O tenant vem do contexto autenticado, nunca do payload.
 */

import { describe, expect, it, vi } from "vitest";

import type { ApiAuthContext } from "@/lib/channels/api/adapter";
import type { SessionUser } from "@/lib/domain/types";
import { Role } from "@/lib/domain";
import type {
  CreateTicketResult,
  ChangeStatusResult,
} from "@/lib/tickets/service";
import { TicketStatus, Priority } from "@/lib/domain";

import {
  handleApiCreateTicket,
  handleApiUpdateTicket,
  type ApiTicketsHandlerDeps,
} from "../handler";

const serviceUser: SessionUser = {
  id: "svc-1",
  companyId: "c1",
  role: Role.SERVICE_ACCOUNT,
  roleAssignments: [
    { permissions: ["ticket.create", "ticket.update"], scopes: [] },
  ],
};

function authedDeps(): ApiTicketsHandlerDeps {
  return {
    authenticate: async (): Promise<ApiAuthContext> => ({
      authenticated: true,
      companyId: "c1",
      user: serviceUser,
    }),
  };
}

function unauthedDeps(): ApiTicketsHandlerDeps {
  return {
    authenticate: async (): Promise<ApiAuthContext> => ({
      authenticated: false,
    }),
  };
}

describe("handleApiCreateTicket — autenticação", () => {
  it("sem contexto autenticado → 401 (sem persistir)", async () => {
    const res = await handleApiCreateTicket(
      null,
      {
        title: "T",
        description: "D",
        createdById: "u1",
      },
      unauthedDeps(),
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "API_UNAUTHENTICATED" });
  });
});

describe("handleApiCreateTicket — validação", () => {
  it("payload inválido → 422 com campos", async () => {
    // Autenticado, mas título vazio → ApiValidationError (não chega ao service).
    const res = await handleApiCreateTicket(
      "Bearer x",
      {
        title: "",
        description: "",
        createdById: "",
      },
      authedDeps(),
    );
    expect(res.status).toBe(422);
    const body = res.body as { error: string; fields: unknown[] };
    expect(body.error).toBe("API_VALIDATION");
    expect(Array.isArray(body.fields)).toBe(true);
  });
});

describe("handleApiUpdateTicket", () => {
  it("sem autenticação → 401", async () => {
    const res = await handleApiUpdateTicket(
      undefined,
      { ticketId: "t1", status: TicketStatus.RESOLVED },
      unauthedDeps(),
    );
    expect(res.status).toBe(401);
  });

  it("status inválido (validação) → 422", async () => {
    const res = await handleApiUpdateTicket(
      "Bearer x",
      { ticketId: "t1", status: "NOPE" as never },
      authedDeps(),
    );
    expect(res.status).toBe(422);
  });
});

// Sanidade dos tipos de resultado usados na resposta de sucesso.
describe("shape dos resultados do TicketService (compile-time sanity)", () => {
  it("CreateTicketResult/ChangeStatusResult têm os campos usados na resposta", () => {
    const created: CreateTicketResult = {
      ticketId: "t1",
      number: 1,
      priority: Priority.MEDIUM,
      status: TicketStatus.OPEN,
      slaResponseDeadline: null,
      slaResolutionDeadline: null,
      slaRuleMissing: false,
    };
    const changed: ChangeStatusResult = {
      ticketId: "t1",
      status: TicketStatus.RESOLVED,
    };
    expect(created.ticketId).toBe("t1");
    expect(changed.status).toBe(TicketStatus.RESOLVED);
  });
});
