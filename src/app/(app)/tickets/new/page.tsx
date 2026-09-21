import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import NewTicketForm from "./NewTicketForm";

export default async function NewTicketPage() {
  const session = await auth();
  const companyId = session!.user.companyId;

  // Carrega as opções de classificação do tenant (escopo por companyId).
  // Subcategory/CategoryItem herdam o tenant via Category ancestral.
  const [services, categories, subcategories, items, queues, teams, units, departments] = await Promise.all([
    prisma.catalogService.findMany({ where: { companyId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.category.findMany({
      where: { companyId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, serviceId: true },
    }),
    prisma.subcategory.findMany({
      where: { category: { companyId } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, categoryId: true },
    }),
    prisma.categoryItem.findMany({
      where: { subcategory: { category: { companyId } } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, subcategoryId: true },
    }),
    prisma.queue.findMany({ where: { companyId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true } }),
    prisma.team.findMany({ where: { companyId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.orgUnit.findMany({ where: { companyId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.department.findMany({ where: { companyId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Novo Ticket</h1>
      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <NewTicketForm
          services={services}
          categories={categories}
          subcategories={subcategories}
          items={items}
          queues={queues}
          teams={teams}
          units={units}
          departments={departments}
        />
      </div>
    </div>
  );
}
