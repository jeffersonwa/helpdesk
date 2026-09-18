/**
 * Barrel do domínio — reexporta enums e tipos para permitir importações via
 * `@/lib/domain` (além dos caminhos específicos `@/lib/domain/enums` e
 * `@/lib/domain/types`, que continuam válidos).
 *
 * A fonte autoritativa dos enums/tipos permanece em `./enums` e `./types`.
 */

export * from "@/lib/domain/enums";
export * from "@/lib/domain/types";
