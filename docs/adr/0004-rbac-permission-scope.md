# 0004 — RBAC por permissão + escopo aplicado no backend

- **Status:** Aceito
- **Requisitos relacionados:** 2.1, 2.3, 2.4, 2.8, 3.1
- **Fonte:** `.kiro/specs/helpdesk-omnichannel/design.md` (seção "Autorização / RBAC")

## Contexto

A plataforma é multi-tenant, com papéis variados (superadmin de plataforma, admins de tenant, agentes, solicitantes) e recursos que pertencem a diferentes escopos (tenant, unidade, fila, time). Autorização baseada apenas em "papéis fixos" é rígida demais, e confiar na UI (esconder botões) não é segurança. Também é preciso garantir **isolamento de tenant**: um usuário nunca acessa recurso de outro tenant.

## Decisão

Adotar **RBAC por permissão + escopo**:

- Permissões no formato `dominio.acao` (ex.: `ticket.assign`, `channel.configure`, `rbac.manage`).
- Papéis (`RoleDef`) agregam permissões; atribuições (`RoleAssignment`) vinculam papéis a **escopos** (`TENANT`, `QUEUE`, etc.), com `refId` opcional para restringir a um recurso específico.
- Um motor de autorização **puro e fail-closed** (`Authorization.can` / `Authorization.assert`) decide na ordem: mesmo tenant → superadmin de plataforma → possui a permissão → o escopo cobre o recurso. Nega por padrão.
- A verificação é **sempre no backend**, antes de qualquer efeito. O `companyId` é **derivado da sessão no servidor**, nunca aceito do corpo da requisição. Esconder controles no frontend é apenas UX.

Cobertura por testes de propriedade: isolamento de tenant (Property 6) e cobertura de escopo (Property 7), além de casos fail-closed.

## Consequências

**Positivas**
- Flexível: novos papéis/permissões sem alterar o motor.
- Seguro por padrão (fail-closed) e com isolamento de tenant garantido.
- Autorização testável isoladamente (motor puro).

**Negativas / trade-offs**
- Modelo mais complexo que papéis fixos (papéis, permissões, escopos, atribuições).
- Exige diligência para aplicar `assert` em todos os pontos de efeito no backend.
