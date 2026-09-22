"use client";

/**
 * Ações da página de Ajuda: imprimir/salvar PDF (usa o diálogo de impressão do
 * navegador → "Salvar como PDF") e baixar o manual em Markdown.
 */
export default function HelpActions({ downloadHref }: { downloadHref: string }) {
  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      <button
        onClick={() => window.print()}
        className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
      >
        Imprimir / Salvar PDF
      </button>
      <a
        href={downloadHref}
        download
        className="inline-flex items-center gap-2 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50"
      >
        Baixar manual (.md)
      </a>
    </div>
  );
}
