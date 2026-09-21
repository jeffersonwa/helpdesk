import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import CatalogForms from "./CatalogForms";

export default async function CatalogPage() {
  const session = await auth();
  if (!["ADMIN", "SUPERADMIN", "SERVICE_MANAGER"].includes(session!.user.role)) {
    redirect("/dashboard");
  }
  const companyId = session!.user.companyId;

  // Árvore do catálogo do tenant (escopo por companyId). Subcategory/CategoryItem
  // não têm companyId próprio: pertencem ao tenant via Category ancestral.
  const services = await prisma.catalogService.findMany({
    where: { companyId },
    orderBy: { name: "asc" },
    include: {
      categories: {
        orderBy: { name: "asc" },
        include: {
          subcategories: {
            orderBy: { name: "asc" },
            include: { items: { orderBy: { name: "asc" } } },
          },
        },
      },
    },
  });

  // Categorias soltas (sem serviço) do tenant, para exibição e selects.
  const looseCategories = await prisma.category.findMany({
    where: { companyId, serviceId: null },
    orderBy: { name: "asc" },
    include: {
      subcategories: {
        orderBy: { name: "asc" },
        include: { items: { orderBy: { name: "asc" } } },
      },
    },
  });

  const allCategories = await prisma.category.findMany({
    where: { companyId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const allSubcategories = await prisma.subcategory.findMany({
    where: { category: { companyId } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const serviceOptions = services.map((s) => ({ id: s.id, name: s.name }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Catálogo de serviços</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Árvore */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border p-6">
          <h2 className="font-semibold mb-4 text-gray-900">Estrutura</h2>
          <div className="space-y-4">
            {services.map((svc) => (
              <div key={svc.id}>
                <p className="font-medium text-gray-800">📦 {svc.name}</p>
                <ul className="ml-5 mt-1 space-y-1">
                  {svc.categories.map((cat) => (
                    <li key={cat.id}>
                      <span className="text-sm text-gray-700">📁 {cat.name}</span>
                      <ul className="ml-5 space-y-0.5">
                        {cat.subcategories.map((sub) => (
                          <li key={sub.id}>
                            <span className="text-sm text-gray-600">📂 {sub.name}</span>
                            <ul className="ml-5">
                              {sub.items.map((item) => (
                                <li key={item.id} className="text-xs text-gray-500">
                                  • {item.name}
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {looseCategories.length > 0 && (
              <div>
                <p className="font-medium text-gray-400">Categorias sem serviço</p>
                <ul className="ml-5 mt-1 space-y-1">
                  {looseCategories.map((cat) => (
                    <li key={cat.id}>
                      <span className="text-sm text-gray-700">📁 {cat.name}</span>
                      <ul className="ml-5 space-y-0.5">
                        {cat.subcategories.map((sub) => (
                          <li key={sub.id}>
                            <span className="text-sm text-gray-600">📂 {sub.name}</span>
                            <ul className="ml-5">
                              {sub.items.map((item) => (
                                <li key={item.id} className="text-xs text-gray-500">
                                  • {item.name}
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {services.length === 0 && looseCategories.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">Catálogo vazio</p>
            )}
          </div>
        </div>

        {/* Formulários */}
        <div>
          <CatalogForms services={serviceOptions} categories={allCategories} subcategories={allSubcategories} />
        </div>
      </div>
    </div>
  );
}
