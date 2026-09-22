import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderManual } from "@/lib/help/markdown";
import HelpActions from "./HelpActions";

/**
 * Central de Ajuda do console.
 *
 * Mostra o manual conforme o PERFIL do usuário:
 *  - SUPERADMIN → manual de operação da plataforma (empresas + tudo);
 *  - ADMIN / gestor / supervisor → manual do administrador da empresa.
 *
 * Clientes não acessam o console; a ajuda deles fica no portal
 * (`/portal/ajuda`). Se por algum motivo um CLIENT cair aqui, é redirecionado.
 *
 * O conteúdo vem dos arquivos estáticos em `docs/manual-*.md` (versionados),
 * lidos no servidor. O `download` usa as cópias em `public/`.
 */
export default async function HelpPage() {
  const session = await auth();
  const role = session!.user.role;

  if (role === "CLIENT") redirect("/dashboard");

  const isSuperadmin = role === "SUPERADMIN";
  const file = isSuperadmin ? "manual-operacao.md" : "manual-admin-empresa.md";
  const downloadHref = `/${file}`;

  // Lê de `public/` (copiado para a imagem de produção standalone; `docs/` não é).
  let html = "";
  try {
    const md = readFileSync(join(process.cwd(), "public", file), "utf8");
    html = renderManual(md);
  } catch {
    html = '<p class="text-sm text-gray-500">Manual indisponível no momento.</p>';
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ajuda</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {isSuperadmin
              ? "Manual de operação da plataforma"
              : "Manual do administrador da empresa"}
          </p>
        </div>
        <HelpActions downloadHref={downloadHref} />
      </div>

      <article
        className="bg-white rounded-2xl shadow-sm border p-8 print:border-0 print:shadow-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
