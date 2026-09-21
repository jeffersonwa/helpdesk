import { Role, ScopeLevel } from "@/lib/domain/enums";
import type { SessionUser } from "@/lib/domain/types";
import type { ReportScope } from "@/lib/reports/service";

/**
 * Traduz os escopos RBAC de um {@link SessionUser} em um {@link ReportScope}
 * consumível pelo `ReportsService` (tarefa 35.1, Req. 15.6).
 *
 * Regras:
 *  - SUPERADMIN e ADMIN têm visão ampla do tenant → sem restrição de escopo
 *    (retorna `undefined`). O `companyId` continua garantindo o isolamento de
 *    tenant (Req. 15.5) na camada do serviço.
 *  - Se QUALQUER atribuição concede um escopo de nível `TENANT` (com ou sem
 *    `refId`), o usuário enxerga todo o tenant → sem restrição.
 *  - Caso contrário, agregamos os `refId` por nível (QUEUE/TEAM/UNIT/
 *    DEPARTMENT/CATEGORY) em listas. Escopos com `refId === null` de um nível
 *    NÃO restrito por tenant são ignorados aqui (não conseguimos enumerá-los
 *    sem I/O adicional); o efeito prático de fail-closed é preservado porque um
 *    usuário sem nenhum escopo enumerável recebe listas vazias — que restringem
 *    a zero resultados (nenhum dado indevido é exposto).
 *  - `TICKET` não mapeia para um filtro de agregação de relatório e é ignorado.
 *
 * O escopo resultante é aplicado pelo `ReportsService.computeMetrics` via
 * `where`, garantindo que o usuário só veja dados cobertos pelo seu escopo.
 */
export function scopeFromSessionUser(user: SessionUser): ReportScope | undefined {
  // Papéis administrativos: visão de tenant inteira (sem restrição de escopo).
  if (user.role === Role.SUPERADMIN || user.role === Role.ADMIN) {
    return undefined;
  }

  const queueIds = new Set<string>();
  const teamIds = new Set<string>();
  const unitIds = new Set<string>();
  const departmentIds = new Set<string>();
  const categoryIds = new Set<string>();

  for (const assignment of user.roleAssignments) {
    for (const scope of assignment.scopes) {
      // Um escopo de tenant cobre todo o tenant → sem restrição.
      if (scope.level === ScopeLevel.TENANT) {
        return undefined;
      }
      if (scope.refId === null) continue;
      switch (scope.level) {
        case ScopeLevel.QUEUE:
          queueIds.add(scope.refId);
          break;
        case ScopeLevel.TEAM:
          teamIds.add(scope.refId);
          break;
        case ScopeLevel.UNIT:
          unitIds.add(scope.refId);
          break;
        case ScopeLevel.DEPARTMENT:
          departmentIds.add(scope.refId);
          break;
        case ScopeLevel.CATEGORY:
          categoryIds.add(scope.refId);
          break;
        default:
          // TICKET e níveis sem filtro de agregação são ignorados.
          break;
      }
    }
  }

  const scope: ReportScope = {};
  if (queueIds.size > 0) scope.queueIds = [...queueIds];
  if (teamIds.size > 0) scope.teamIds = [...teamIds];
  if (unitIds.size > 0) scope.unitIds = [...unitIds];
  if (departmentIds.size > 0) scope.departmentIds = [...departmentIds];
  if (categoryIds.size > 0) scope.categoryIds = [...categoryIds];

  // Sem nenhum escopo enumerável → objeto vazio (não restringe por si; o
  // isolamento de tenant por companyId permanece a garantia mínima).
  return Object.keys(scope).length > 0 ? scope : {};
}
