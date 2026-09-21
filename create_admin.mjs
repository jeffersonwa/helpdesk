// Cria o primeiro SUPERADMIN + a empresa de plataforma, diretamente no banco.
// Rodado DENTRO do container `worker` (tem Prisma Client + bcryptjs).
// Idempotente: se o e-mail já existir, não recria.
//
// Variáveis de ambiente esperadas:
//   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME (opcional), COMPANY_NAME/SLUG (opcional)
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME || "Administrador";
const companyName = process.env.COMPANY_NAME || "Plataforma";
const companySlug = process.env.COMPANY_SLUG || "plataforma";

if (!email || !password) {
  console.error("ERRO: defina ADMIN_EMAIL e ADMIN_PASSWORD.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const existing = await prisma.user.findUnique({ where: { email } });
if (existing) {
  console.log(`Usuário ${email} já existe (id=${existing.id}). Nada a fazer.`);
  process.exit(0);
}

const hash = await bcrypt.hash(password, 12);

const company = await prisma.company.upsert({
  where: { slug: companySlug },
  update: {},
  create: { name: companyName, slug: companySlug },
});

const user = await prisma.user.create({
  data: {
    name,
    email,
    password: hash,
    role: "SUPERADMIN",
    companyId: company.id,
  },
  select: { id: true, email: true, role: true },
});

console.log(`OK: SUPERADMIN criado → ${user.email} (id=${user.id}) na empresa ${company.slug}.`);
process.exit(0);
