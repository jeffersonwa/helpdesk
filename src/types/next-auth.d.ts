// Os campos de tenant de `Session.user` (id, role, companyId, companyName,
// companySlug) agora fazem parte das declarações de tipo do próprio módulo em
// `src/types/vendor/next-auth.d.ts` (mapeado via `paths` no tsconfig, porque a
// versão instalada de next-auth não publica seus `.d.ts` neste ambiente).
//
// Este arquivo é mantido intencionalmente vazio para documentar o histórico e
// evitar uma augmentation duplicada que conflitaria com o `vendor`.
export {};
