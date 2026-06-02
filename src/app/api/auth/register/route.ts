import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
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
  const session = await auth();
  if (!session || session.user.role !== "SUPERADMIN") {
    return NextResponse.json({ error: "Apenas SUPERADMIN pode criar empresas" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { name, email, password, companyName, companySlug } = parsed.data;

  const existing = await prisma.company.findUnique({ where: { slug: companySlug } });
  if (existing) return NextResponse.json({ error: "Slug já em uso" }, { status: 409 });

  const emailExists = await prisma.user.findUnique({ where: { email } });
  if (emailExists) return NextResponse.json({ error: "Email já cadastrado" }, { status: 409 });

  const hash = await bcrypt.hash(password, 12);

  const company = await prisma.company.create({
    data: {
      name: companyName,
      slug: companySlug,
      users: {
        create: { name, email, password: hash, role: "ADMIN" },
      },
    },
    include: { users: { select: { id: true, email: true } } },
  });

  return NextResponse.json({ companyId: company.id, slug: company.slug }, { status: 201 });
}
