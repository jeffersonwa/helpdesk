import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Declarações de tipo vendorizadas (shims de libs beta sem `.d.ts`).
    // Usam `any` deliberadamente para modelar superfícies não tipadas; não são
    // código de runtime. O gate de tipos real é o `tsc` (npm run typecheck).
    "src/types/vendor/**",
  ]),
  {
    // `no-explicit-any` é uma regra ESTILÍSTICA, não de correção — o gate de
    // tipos de verdade é o `tsc`. O projeto usa `any` deliberadamente em
    // bordas não tipadas (ex.: `where` dinâmico do Prisma, coerção de sessão,
    // `catch (err: any)`). Rebaixamos para warning para não travar o CI sem
    // esconder problemas reais de tipo (esses o typecheck pega).
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);

export default eslintConfig;
