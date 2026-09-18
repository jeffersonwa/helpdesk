/**
 * Route handler da ingestão de tickets via API (v1) — tarefa 21.1.
 *
 * Fonte: `.kiro/specs/helpdesk-omnichannel/design.md` e requisito 9.
 *
 * ------------------------------------------------------------------------
 * PATH v1: `src/app/api/v1/tickets`.
 * ------------------------------------------------------------------------
 * A rota legada `src/app/api/tickets/route.ts` (autenticada por sessão de
 * usuário) permanece INTACTA. Esta v1 é a ingestão por API de
 * integração/serviço, autenticada por `Authorization: Bearer <token>`.
 *
 *  - POST      → cria ticket (ApiAdapter.createTicketViaApi).
 *  - PATCH/PUT → atualiza status (ApiAdapter.updateTicketViaApi).
 *
 * 401 (não autenticado), 403 (não autorizado), 422 (validação). O tenant vem
 * sempre do token (servidor), nunca do payload.
 */

import { NextResponse, type NextRequest } from "next/server";

import { createEnvApiTokenAuthenticator } from "@/lib/channels/wiring";
import type {
  ApiCreateTicketInput,
  ApiUpdateTicketInput,
} from "@/lib/channels/api/adapter";
import {
  handleApiCreateTicket,
  handleApiUpdateTicket,
  type ApiTicketsHandlerDeps,
} from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildDeps(): ApiTicketsHandlerDeps {
  return { authenticate: createEnvApiTokenAuthenticator() };
}

/** Lê o corpo JSON com segurança; retorna `null` em JSON inválido. */
async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const body = await readJson(req);
  if (!body) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 422 });
  }
  const result = await handleApiCreateTicket(
    req.headers.get("authorization"),
    body as unknown as ApiCreateTicketInput,
    buildDeps(),
  );
  return NextResponse.json(result.body as Record<string, unknown>, {
    status: result.status,
  });
}

async function update(req: NextRequest): Promise<Response> {
  const body = await readJson(req);
  if (!body) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 422 });
  }
  const result = await handleApiUpdateTicket(
    req.headers.get("authorization"),
    body as unknown as ApiUpdateTicketInput,
    buildDeps(),
  );
  return NextResponse.json(result.body as Record<string, unknown>, {
    status: result.status,
  });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  return update(req);
}

export async function PUT(req: NextRequest): Promise<Response> {
  return update(req);
}
