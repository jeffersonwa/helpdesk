import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produz o bundle "standalone" (.next/standalone) usado pela imagem Docker de
  // produção (tarefa 36.1). O output standalone copia apenas as dependências
  // necessárias para rodar o servidor, mantendo a imagem enxuta e a aplicação
  // stateless (Req. 18.4). Aditivo: não altera o comportamento de `next dev`.
  output: "standalone",
};

export default nextConfig;
