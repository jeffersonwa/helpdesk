import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "./prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authConfig } from "./auth.config";
import { rateLimit, getClientIp } from "./rate-limit";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      async authorize(credentials, request) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        // Limita tentativas por IP e por email para dificultar força bruta
        const ip = request ? getClientIp(request) : "unknown";
        const ipLimit = rateLimit(`login:ip:${ip}`, 20, 10 * 60 * 1000);
        const emailLimit = rateLimit(`login:email:${parsed.data.email.toLowerCase()}`, 5, 10 * 60 * 1000);
        if (!ipLimit.allowed || !emailLimit.allowed) {
          console.warn(`[auth] Rate limit atingido para login: ip=${ip} email=${parsed.data.email}`);
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
          include: { company: true },
        });

        if (!user) return null;
        const valid = await bcrypt.compare(parsed.data.password, user.password);
        if (!valid) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          companyId: user.companyId,
          companyName: user.company.name,
          companySlug: user.company.slug,
        };
      },
    }),
  ],
});
