"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  createCatalogServiceAction,
  createCategoryAction,
  createSubcategoryAction,
  createCategoryItemAction,
  type ActionResult,
} from "./actions";

interface Option {
  id: string;
  name: string;
}

interface Props {
  services: Option[];
  categories: Option[];
  subcategories: Option[];
}

/** Bloco genérico de feedback (erro/sucesso). */
function Feedback({ error, success }: { error: string; success: string }) {
  return (
    <>
      {error && <p className="text-red-500 text-xs bg-red-50 p-2 rounded-lg">{error}</p>}
      {success && <p className="text-green-600 text-xs bg-green-50 p-2 rounded-lg">{success}</p>}
    </>
  );
}

export default function CatalogForms({ services, categories, subcategories }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<Record<string, { error: string; success: string }>>({});

  function run(key: string, fn: () => Promise<ActionResult>, form: HTMLFormElement) {
    setState((s) => ({ ...s, [key]: { error: "", success: "" } }));
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        setState((s) => ({ ...s, [key]: { error: res.error, success: "" } }));
      } else {
        setState((s) => ({ ...s, [key]: { error: "", success: "Criado com sucesso!" } }));
        form.reset();
        router.refresh();
      }
    });
  }

  const inputCls =
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500";
  const btnCls =
    "w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-60";

  return (
    <div className="space-y-6">
      {/* Serviço de catálogo */}
      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <h2 className="font-semibold mb-4 text-gray-900">Novo serviço</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const name = String(new FormData(f).get("name") ?? "");
            run("service", () => createCatalogServiceAction({ name }), f);
          }}
          className="space-y-3"
        >
          <input name="name" required maxLength={120} placeholder="Nome do serviço" className={inputCls} />
          <Feedback error={state.service?.error ?? ""} success={state.service?.success ?? ""} />
          <button disabled={pending} className={btnCls}>
            Adicionar serviço
          </button>
        </form>
      </div>

      {/* Categoria */}
      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <h2 className="font-semibold mb-4 text-gray-900">Nova categoria</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const fd = new FormData(f);
            const name = String(fd.get("name") ?? "");
            const serviceId = String(fd.get("serviceId") ?? "");
            run("category", () => createCategoryAction({ name, serviceId: serviceId || undefined }), f);
          }}
          className="space-y-3"
        >
          <input name="name" required maxLength={120} placeholder="Nome da categoria" className={inputCls} />
          <select name="serviceId" className={inputCls} defaultValue="">
            <option value="">Sem serviço</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Feedback error={state.category?.error ?? ""} success={state.category?.success ?? ""} />
          <button disabled={pending} className={btnCls}>
            Adicionar categoria
          </button>
        </form>
      </div>

      {/* Subcategoria */}
      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <h2 className="font-semibold mb-4 text-gray-900">Nova subcategoria</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const fd = new FormData(f);
            const name = String(fd.get("name") ?? "");
            const categoryId = String(fd.get("categoryId") ?? "");
            run("subcategory", () => createSubcategoryAction({ name, categoryId }), f);
          }}
          className="space-y-3"
        >
          <input name="name" required maxLength={120} placeholder="Nome da subcategoria" className={inputCls} />
          <select name="categoryId" required className={inputCls} defaultValue="">
            <option value="" disabled>
              Selecione a categoria
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Feedback error={state.subcategory?.error ?? ""} success={state.subcategory?.success ?? ""} />
          <button disabled={pending || categories.length === 0} className={btnCls}>
            Adicionar subcategoria
          </button>
        </form>
      </div>

      {/* Item de categoria */}
      <div className="bg-white rounded-2xl shadow-sm border p-6">
        <h2 className="font-semibold mb-4 text-gray-900">Novo item</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const fd = new FormData(f);
            const name = String(fd.get("name") ?? "");
            const subcategoryId = String(fd.get("subcategoryId") ?? "");
            run("item", () => createCategoryItemAction({ name, subcategoryId }), f);
          }}
          className="space-y-3"
        >
          <input name="name" required maxLength={120} placeholder="Nome do item" className={inputCls} />
          <select name="subcategoryId" required className={inputCls} defaultValue="">
            <option value="" disabled>
              Selecione a subcategoria
            </option>
            {subcategories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Feedback error={state.item?.error ?? ""} success={state.item?.success ?? ""} />
          <button disabled={pending || subcategories.length === 0} className={btnCls}>
            Adicionar item
          </button>
        </form>
      </div>
    </div>
  );
}
