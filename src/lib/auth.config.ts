import type { NextAuthConfig } from "next-auth";

// Config edge-safe: sem Prisma, sem bcrypt
export const authConfig = {
  // Atrás de um proxy reverso (Traefik), o host chega via cabeçalhos
  // encaminhados. O NextAuth v5 exige confiar no host explicitamente, senão
  // rejeita com `UntrustedHost`. Em produção o host canônico é fixado por
  // NEXTAUTH_URL (https://csc.nitecnologia.tec.br), então confiar é seguro.
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isAuthPage =
        nextUrl.pathname.startsWith("/login") ||
        nextUrl.pathname.startsWith("/register") ||
        nextUrl.pathname.startsWith("/forgot-password") ||
        nextUrl.pathname.startsWith("/reset-password");

      if (isAuthPage) {
        if (isLoggedIn) return Response.redirect(new URL("/dashboard", nextUrl));
        return true;
      }

      if (!isLoggedIn) return false;
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
        token.companyId = (user as any).companyId;
        token.companyName = (user as any).companyName;
        token.companySlug = (user as any).companySlug;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      session.user.role = token.role as string;
      session.user.companyId = token.companyId as string;
      session.user.companyName = token.companyName as string;
      session.user.companySlug = token.companySlug as string;
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
