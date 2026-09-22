import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderManual } from "@/lib/help/markdown";
import HelpActions from "@/app/(app)/help/HelpActions";

/**
 * Ajuda do portal de autoatendimento (usuário final / cliente).
 *
 * Mostra o manual do usuário final. O conteúdo vem de `docs/manual-usuario-final.md`
 * (versionado), lido no servidor; o download usa a cópia em `public/`.
 */
export default async function PortalAjudaPage() {
  const session = await auth();
  if (!session) redirect("/login");

  // Lê de `public/` (copiado para a imagem de produção standalone; `docs/` não é).
  let html = "";
  try {
    const md = readFileSync(
      join(process.cwd(), "public", "manual-usuario-final.md"),
      "utf8",
    );
    html = renderManual(md);
  } catch {
    html = '<p class="text-sm text-gray-500">Manual indisponível no momento.</p>';
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ajuda</h1>
          <p className="text-sm text-gray-500 mt-0.5">Como usar o portal de atendimento</p>
        </div>
        <HelpActions downloadHref="/manual-usuario-final.md" />
      </div>

      <article
        className="bg-white rounded-2xl border shadow-sm p-8 print:border-0 print:shadow-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
