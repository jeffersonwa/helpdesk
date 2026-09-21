// Tipos para `next-auth/react` (ver nota em ./next-auth.d.ts).
import type { Session } from "next-auth";

export function signIn(
  provider?: string,
  options?: Record<string, unknown>,
): Promise<any>;
export function signOut(options?: Record<string, unknown>): Promise<any>;
export function useSession(): {
  data: Session | null;
  status: "authenticated" | "loading" | "unauthenticated";
  update: (...args: any[]) => Promise<any>;
};
export function getSession(...args: any[]): Promise<Session | null>;
export const SessionProvider: (props: {
  children?: unknown;
  session?: unknown;
}) => any;
