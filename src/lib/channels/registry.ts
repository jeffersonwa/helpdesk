/**
 * Registro de adaptadores de canal e seleção de provider por ambiente.
 *
 * Fonte autoritativa: `.kiro/specs/helpdesk-omnichannel/design.md`
 * (seção "Adapter real vs. mock") e requisitos 5.1, 5.7, 5.8.
 *
 * Regras de projeto:
 *  - Este módulo NÃO importa adaptadores concretos (cloud/mock), evitando ciclo
 *    de dependência e mantendo-o testável isoladamente. Os adaptadores concretos
 *    (tarefas 14/15) se auto-registram via `registerAdapter`, ou o wiring da
 *    aplicação os injeta em tempo de inicialização.
 *  - A seleção do provider de WhatsApp é feita por env `CHANNEL_WHATSAPP_PROVIDER`
 *    (`whatsapp_cloud` | `whatsapp_mock`), com padrão MOCK fora de produção e
 *    CLOUD em produção.
 *  - O adaptador MOCK é BLOQUEADO em produção (`NODE_ENV === "production"`),
 *    conforme Req 5.8 / restrição inviolável do plano.
 */

import { ChannelProvider, ChannelType } from "@/lib/domain";
import type { ChannelAdapter } from "@/lib/channels/adapter";

type Env = Record<string, string | undefined>;

/** Valores aceitos na env `CHANNEL_WHATSAPP_PROVIDER`. */
export const WHATSAPP_PROVIDER_ENV_VAR = "CHANNEL_WHATSAPP_PROVIDER" as const;

/**
 * Mapa (type, provider) -> adaptador registrado.
 * A chave é composta para permitir múltiplos providers por tipo de canal.
 */
const registry = new Map<string, ChannelAdapter>();

function keyOf(type: ChannelType, provider: ChannelProvider): string {
  return `${type}:${provider}`;
}

/**
 * Registra (ou substitui) um adaptador para o par (type, provider) que ele
 * próprio declara. Chamado pelo wiring da aplicação ou pelos adaptadores
 * concretos ao serem carregados.
 */
export function registerAdapter(adapter: ChannelAdapter): void {
  registry.set(keyOf(adapter.type, adapter.provider), adapter);
}

/**
 * Recupera um adaptador registrado. Retorna `undefined` se nenhum adaptador
 * estiver registrado para o par informado.
 */
export function getAdapter(
  type: ChannelType,
  provider: ChannelProvider,
): ChannelAdapter | undefined {
  return registry.get(keyOf(type, provider));
}

/** Remove todos os registros — utilitário para testes/reinicialização. */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * `true` quando o ambiente indica produção. Centralizado para permitir
 * override em testes por meio do parâmetro `env`.
 */
export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV === "production";
}

/**
 * Resolve o `ChannelProvider` de WhatsApp a partir do ambiente.
 *
 * - `whatsapp_cloud` -> `ChannelProvider.WHATSAPP_CLOUD`
 * - `whatsapp_mock`  -> `ChannelProvider.WHATSAPP_MOCK`
 * - ausente/desconhecido -> CLOUD em produção, MOCK caso contrário.
 *
 * NÃO importa adaptadores concretos; apenas mapeia a seleção.
 */
export function resolveWhatsAppProvider(env: Env = process.env): ChannelProvider {
  const raw = env[WHATSAPP_PROVIDER_ENV_VAR]?.trim().toLowerCase();

  switch (raw) {
    case "whatsapp_cloud":
      return ChannelProvider.WHATSAPP_CLOUD;
    case "whatsapp_mock":
      return ChannelProvider.WHATSAPP_MOCK;
    default:
      // Padrão seguro: real em produção, mock em desenvolvimento/teste.
      return isProduction(env)
        ? ChannelProvider.WHATSAPP_CLOUD
        : ChannelProvider.WHATSAPP_MOCK;
  }
}

/** Providers considerados "mock" (proibidos em produção). */
const MOCK_PROVIDERS: ReadonlySet<ChannelProvider> = new Set([
  ChannelProvider.WHATSAPP_MOCK,
]);

/** Predicado puro: o provider informado é um provider MOCK? */
export function isMockProvider(provider: ChannelProvider): boolean {
  return MOCK_PROVIDERS.has(provider);
}

/**
 * Predicado: o uso de mock é permitido no ambiente atual?
 * Mock é permitido em qualquer ambiente EXCETO produção (Req 5.8).
 */
export function isMockAllowed(env: Env = process.env): boolean {
  return !isProduction(env);
}

/**
 * Guarda inviolável (Req 5.8): lança se o provider selecionado for MOCK
 * enquanto `NODE_ENV === "production"`.
 *
 * As tarefas 14/15 (adaptadores concretos) usam esta guarda antes de habilitar
 * o MOCK. Documentação: **o MOCK é bloqueado em produção**.
 */
export function assertMockAllowed(env: Env = process.env): void {
  if (!isMockAllowed(env)) {
    throw new Error(
      "O adaptador MOCK não é permitido em produção (NODE_ENV=production). " +
        "Configure CHANNEL_WHATSAPP_PROVIDER=whatsapp_cloud para usar a Cloud API oficial.",
    );
  }
}
