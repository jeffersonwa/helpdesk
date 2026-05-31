import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";

const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  companyName: z.string().min(2),
  companySlug: z.string().min(2).regex(/^[a-z0-9-]+$/),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { name, email, password, companyName, companySlug } = parsed.data;

  const existing = await prisma.company.findUnique({ where: { slug: companySlug } });
  if (existing) return NextResponse.json({ error: "Slug já em uso" }, { status: 409 });

  const hash = await bcrypt.hash(password, 12);

  const company = await prisma.company.create({
    data: {
      name: companyName,
      slug: companySlug,
      users: {
        create: { name, email, password: hash, role: "ADMIN" },
      },
    },
  });

  return NextResponse.json({ companyId: company.id }, { status: 201 });
}
