"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { searchKb, type PortalSearchState } from "./actions";

/**
 * Caixa de busca da base de conhecimento (tarefa 34.1).
 *
 * Client Component no padrão `useState` + `useTransition` (o repo NÃO usa
 * react-hook-form). Chama a Server Action `searchKb`, que retorna apenas
 * artigos publicados do tenant. Sem resultados exibe "nenhum resultado"
 * PRESERVANDO o termo consultado (Req. 14.7).
 */
export default function KbSearch() {
  const [term, setTerm] = useState("");
  const [result, setResult] = useState<PortalSearchState | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = term.trim();
    if (value.length === 0) {
      setResult(null);
      return;
    }
    startTransition(async () => {
      const state = await searchKb(value);
      setResult(state);
    });
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            size={18}
          />
          <input
            type="text"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            maxLength={200}
            placeholder="Buscar artigos..."
            className="w-full pl-10 pr-3 py-2.5 rounded-xl border bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending ? "Buscando..." : "Buscar"}
        </button>
      </form>

      {result && !result.ok && (
        <p className="mt-3 text-sm text-red-600">{result.error}</p>
      )}

      {result && result.ok && (
        <div className="mt-4">
          {result.empty ? (
            <div className="bg-white rounded-2xl border shadow-sm p-6 text-center text-gray-500">
              Nenhum resultado para{" "}
              <span className="font-medium text-gray-700">“{result.term}”</span>.
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-3">
                {result.articles.length} resultado
                {result.articles.length !== 1 ? "s" : ""} para{" "}
                <span className="font-medium text-gray-700">“{result.term}”</span>
              </p>
              <div className="space-y-3">
                {result.articles.map((a) => (
                  <Link
                    key={a.id}
                    href={`/portal/kb/${a.id}`}
                    className="block bg-white rounded-2xl border shadow-sm p-5 hover:border-blue-300 transition-colors"
                  >
                    <h3 className="font-medium text-gray-900">{a.title}</h3>
                    <p className="text-sm text-gray-500 mt-1 line-clamp-2">{a.body}</p>
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
