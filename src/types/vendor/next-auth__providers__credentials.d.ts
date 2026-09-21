// Tipos para `next-auth/providers/credentials` (ver nota em ./next-auth.d.ts).
declare function Credentials(config: {
  authorize?: (credentials: any, request?: any) => any;
  [key: string]: unknown;
}): unknown;
export default Credentials;
