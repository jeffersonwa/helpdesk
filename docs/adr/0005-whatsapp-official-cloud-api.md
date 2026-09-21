# 0005 — WhatsApp exclusivamente via Cloud API oficial

- **Status:** Aceito
- **Requisitos relacionados:** 6.1, 6.2, 6.5
- **Fonte:** `.kiro/specs/helpdesk-omnichannel/design.md` (seção "WhatsApp") · ver também `docs/whatsapp-setup.md`

## Contexto

Existem múltiplas formas de integrar o WhatsApp: a **Cloud API oficial da Meta** (`graph.facebook.com`) e diversas abordagens não oficiais (WhatsApp Web, QR Code, scraping, automação de navegador, bibliotecas de terceiros). As não oficiais violam os Termos da Meta, são frágeis (quebram a cada mudança do WhatsApp Web), sujeitas a bloqueio/banimento do número e representam risco legal e de segurança para uma plataforma corporativa.

## Decisão

Suportar o WhatsApp **exclusivamente** pela **Meta WhatsApp Business Cloud API oficial**. Todas as chamadas de saída vão contra `graph.facebook.com` via `fetch` nativo. É **proibido** WhatsApp Web, QR Code, scraping, automação de navegador ou bibliotecas não oficiais; qualquer tentativa por via não oficial é **rejeitada sem chamada externa** e registrada em auditoria (Req. 6.1, 6.2).

Os webhooks de entrada são verificados via handshake GET (`hub.verify_token`) e assinatura **HMAC `X-Hub-Signature-256`** (comparação em tempo constante) antes de qualquer processamento. Os segredos (`app_secret`, `verify_token`, `access_token`) vêm de env/secret manager por `secretRef`, nunca do código. Um `WhatsAppMockAdapter` existe apenas para desenvolvimento e é **bloqueado em produção**.

## Consequências

**Positivas**
- Conformidade com os Termos da Meta; sem risco de banimento por uso não oficial.
- Estabilidade: contrato de API versionado e suportado oficialmente.
- Segurança: verificação de assinatura e segredos externos ao código.

**Negativas / trade-offs**
- Depende do onboarding oficial (verificação de negócio, número aprovado, templates aprovados).
- Restrições da plataforma se aplicam (ex.: janela de 24h, necessidade de templates para mensagens fora da janela) — tratadas explicitamente no adapter.
