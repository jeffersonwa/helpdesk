import Link from "next/link";
import { auth } from "@/lib/auth";
import { KnowledgeBaseService, defaultKbClient } from "@/lib/kb/service";
import { BookOpen } from "lucide-react";
import KbSearch from "./KbSearch";

/**
 * Base de conhecimento do portal (tarefa 34.1).
 *
 * Server Component: lista os artigos PUBLICADOS do tenant do solicitante
 * (Req. 14.2, 14.3) — o `companyId` vem SEMPRE da sessão (Req. 14.4). A busca é
 * um Client Component que chama a Server Action `searchKb` (Req. 14.6, 14.7).
 */
export default async function KbPage() {
  const session = await auth();
  const companyId = session!.user.companyId;

  const articles = await KnowledgeBaseService.listPublished(defaultKbClient(), companyId);

  return (
    <div>
      <div className="flex items-center gap-2 mb-6">
        <BookOpen className="text-blue-600" size={24} />
        <h1 className="text-2xl font-bold">Base de conhecimento</h1>
      </div>

      <KbSearch />

      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mt-8 mb-3">
        Todos os artigos
      </h2>
      <div className="space-y-3">
        {articles.map((a) => (
          <Link
            key={a.id}
            href={`/portal/kb/${a.id}`}
            className="block bg-white rounded-2xl border shadow-sm p-5 hover:border-blue-300 transition-colors"
          >
            <h3 className="font-medium text-gray-900">{a.title}</h3>
            <p className="text-sm text-gray-500 mt-1 line-clamp-2">{a.body}</p>
          </Link>
        ))}
        {articles.length === 0 && (
          <div className="bg-white rounded-2xl border shadow-sm p-8 text-center text-gray-400">
            Nenhum artigo publicado ainda.
          </div>
        )}
      </div>
    </div>
  );
}
