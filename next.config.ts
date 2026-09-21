import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produz o bundle "standalone" (.next/standalone) usado pela imagem Docker de
  // produção (tarefa 36.1). O output standalone copia apenas as dependências
  // necessárias para rodar o servidor, mantendo a imagem enxuta e a aplicação
  // stateless (Req. 18.4). Aditivo: não altera o comportamento de `next dev`.
  output: "standalone",

  typescript: {
    // O type-check NÃO é pulado do fluxo — ele roda como gate dedicado via
    // `npm run typecheck` (usa tsconfig.typecheck.json, que mapeia os `.d.ts`
    // vendorizados de next-auth/lucide-react). Aqui desligamos apenas o
    // type-check EMBUTIDO no `next build` porque as versões beta instaladas de
    // `next-auth` e `lucide-react` não publicam seus arquivos `.d.ts` neste
    // ambiente, e o único jeito de supri-los para o `tsc` (via `paths`) faria
    // o Turbopack resolver o módulo para o `.d.ts` (sem runtime), quebrando o
    // bundle. Separar as duas etapas mantém o gate de tipos sem quebrar o build.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
