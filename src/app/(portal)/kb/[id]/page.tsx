import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { KnowledgeBaseService, defaultKbClient } from "@/lib/kb/service";
import { ArrowLeft } from "lucide-react";

/**
 * Detalhe de um artigo publicado no portal (tarefa 34.1).
 *
 * `getPublishedById` devolve o artigo SOMENTE se publicado E do tenant da
 * sessão. Rascunho/arquivado ou artigo de outro tenant → `null`, que traduzimos
 * em `notFound()` (Next). Assim, um recurso não publicado ou cross-tenant é
 * tratado como "não encontrado", sem revelar sua existência (Req. 14.3, 14.5).
 */
export default async function KbArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  const companyId = session!.user.companyId;
  const { id } = await params;

  const article = await KnowledgeBaseService.getPublishedById(
    defaultKbClient(),
    companyId,
    id,
  );

  if (!article) notFound();

  return (
    <article>
      <Link
        href="/portal/kb"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-600 mb-6"
      >
        <ArrowLeft size={16} /> Voltar para a base de conhecimento
      </Link>

      <div className="bg-white rounded-2xl border shadow-sm p-8">
        <h1 className="text-2xl font-bold mb-4">{article.title}</h1>
        <div className="prose prose-sm max-w-none whitespace-pre-wrap text-gray-700">
          {article.body}
        </div>
      </div>
    </article>
  );
}
