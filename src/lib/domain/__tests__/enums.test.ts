import { describe, expect, it } from "vitest";

import {
  ApprovalState,
  ChannelProvider,
  ChannelType,
  ConversationState,
  EscalationTrigger,
  Impact,
  MessageDirection,
  MessageType,
  OutboxState,
  Priority,
  Role,
  ScopeLevel,
  TicketStatus,
  Urgency,
} from "@/lib/domain/enums";

/**
 * Cada caso descreve o conjunto de membros esperado (na ordem do design).
 * Validamos dois invariantes por enum:
 *  1. `Object.values(Enum)` é exatamente o array esperado (ordem inclusa).
 *  2. É um enum de string: cada chave é igual ao seu valor.
 */
const cases: ReadonlyArray<{
  name: string;
  enumObj: Record<string, string>;
  expected: string[];
}> = [
  { name: "Priority", enumObj: Priority, expected: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
  { name: "Impact", enumObj: Impact, expected: ["LOW", "MEDIUM", "HIGH"] },
  { name: "Urgency", enumObj: Urgency, expected: ["LOW", "MEDIUM", "HIGH"] },
  {
    name: "TicketStatus",
    enumObj: TicketStatus,
    expected: [
      "OPEN",
      "IN_PROGRESS",
      "WAITING",
      "PENDING_APPROVAL",
      "RESOLVED",
      "CLOSED",
      "CANCELLED",
    ],
  },
  {
    name: "ChannelType",
    enumObj: ChannelType,
    expected: ["WEB", "WHATSAPP", "EMAIL", "PUBLIC_FORM", "API"],
  },
  {
    name: "ChannelProvider",
    enumObj: ChannelProvider,
    expected: [
      "WHATSAPP_CLOUD",
      "WHATSAPP_MOCK",
      "EMAIL_RESEND",
      "EMAIL_IMAP",
      "INTERNAL",
    ],
  },
  {
    name: "MessageDirection",
    enumObj: MessageDirection,
    expected: ["INBOUND", "OUTBOUND"],
  },
  {
    name: "MessageType",
    enumObj: MessageType,
    expected: ["TEXT", "IMAGE", "DOCUMENT", "AUDIO", "VIDEO", "TEMPLATE", "SYSTEM"],
  },
  {
    name: "ConversationState",
    enumObj: ConversationState,
    expected: ["OPEN", "PENDING", "RESOLVED", "EXPIRED"],
  },
  {
    name: "ApprovalState",
    enumObj: ApprovalState,
    expected: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
  },
  {
    name: "EscalationTrigger",
    enumObj: EscalationTrigger,
    expected: ["RESPONSE_BREACH", "RESOLUTION_BREACH", "INACTIVITY", "MANUAL"],
  },
  {
    name: "OutboxState",
    enumObj: OutboxState,
    expected: ["PENDING", "PROCESSING", "SENT", "FAILED"],
  },
  {
    name: "ScopeLevel",
    enumObj: ScopeLevel,
    expected: ["TENANT", "UNIT", "DEPARTMENT", "TEAM", "QUEUE", "CATEGORY", "TICKET"],
  },
  {
    name: "Role",
    enumObj: Role,
    expected: [
      "SUPERADMIN",
      "ADMIN",
      "SERVICE_MANAGER",
      "SUPERVISOR",
      "AGENT",
      "SPECIALIST",
      "APPROVER",
      "AUDITOR",
      "READONLY",
      "INTEGRATION",
      "SERVICE_ACCOUNT",
      "CLIENT",
    ],
  },
];

describe("domain enums", () => {
  for (const { name, enumObj, expected } of cases) {
    describe(name, () => {
      it("has the exact member set in the design's order", () => {
        expect(Object.values(enumObj)).toEqual(expected);
      });

      it("is a string enum (key === value)", () => {
        expect(Object.keys(enumObj)).toEqual(expected);
        for (const key of Object.keys(enumObj)) {
          expect(enumObj[key]).toBe(key);
        }
      });
    });
  }
});
