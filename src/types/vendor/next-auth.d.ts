// Declarações de tipo para `next-auth` (raiz).
//
// POR QUÊ: a versão `next-auth@5.0.0-beta.31` instalada neste ambiente não
// materializa os arquivos `.d.ts` que seu `package.json` referencia (só vêm os
// `*.d.ts.map`). Sem eles o `tsc`/`next build` emite TS7016. Estes tipos são
// mapeados via `paths` no tsconfig, então valem SOMENTE para o type-check —
// em runtime o bundler resolve o `.js` real do pacote. Podem ser removidos
// quando o pacote passar a publicar seus `.d.ts` (ou em outro ambiente onde
// eles estejam presentes; o `paths` continua inofensivo).

export interface Session {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    companyId: string;
    companyName: string;
    companySlug: string;
    [key: string]: unknown;
  };
  expires?: string;
  [key: string]: unknown;
}

export interface User {
  id?: string;
  name?: string | null;
  email?: string | null;
  [key: string]: unknown;
}

export interface NextAuthConfig {
  providers: unknown[];
  pages?: Record<string, string>;
  session?: Record<string, unknown>;
  secret?: string;
  trustHost?: boolean;
  callbacks?: {
    authorized?: (params: { auth: any; request: any }) => any;
    jwt?: (params: { token: any; user?: any }) => any;
    session?: (params: { session: any; token: any }) => any;
    [key: string]: ((...args: any[]) => any) | undefined;
  };
  [key: string]: unknown;
}

export interface NextAuthResult {
  auth: (...args: any[]) => any;
  handlers: { GET: (...args: any[]) => any; POST: (...args: any[]) => any };
  signIn: (...args: any[]) => Promise<any>;
  signOut: (...args: any[]) => Promise<any>;
}

declare function NextAuth(config: NextAuthConfig): NextAuthResult;
export default NextAuth;
