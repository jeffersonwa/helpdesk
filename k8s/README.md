# Manifestos Kubernetes — JÁ Helpdesk

> Tarefa 36.3 · Requisitos 18.4, 18.5 · Fonte: `.kiro/specs/helpdesk-omnichannel/design.md` (seção "Implantação → Prontidão para Kubernetes").

Estes manifestos são de **prontidão** (opcionais). O Kubernetes **não é obrigatório**: a **mesma imagem** roda sob Docker Compose (ver `docker-compose.yml` na raiz). O objetivo aqui é demonstrar que a aplicação é portável e escalável horizontalmente, não substituir o Compose.

## Conteúdo

| Arquivo | Recurso | Papel |
| --- | --- | --- |
| `configmap.yaml` | `ConfigMap helpdesk-config` | Config **não sensível** (NEXTAUTH_URL, CHANNEL_WHATSAPP_PROVIDER, intervalos de worker, config S3 não sensível). |
| `secret.example.yaml` | `Secret helpdesk-secrets` (template) | **Modelo** com placeholders. **Não aplicar como está.** Use External Secrets / Sealed Secrets / CSI. |
| `app-deployment.yaml` | `Deployment helpdesk-app` | Serviço web, 2 réplicas, probes em `/api/health`. |
| `worker-deployment.yaml` | `Deployment helpdesk-worker` | Jobs (outbox + escalonamento). Alternativa em CronJob comentada. |
| `service.yaml` | `Service helpdesk-app` | ClusterIP interno. |
| `ingress.yaml` | `Ingress helpdesk` | Host `csc.nitecnologia.tec.br` + TLS. |

## Princípios de implantação

- **Stateless (Req. 18.4):** o `app` não grava estado em disco local; sessão em JWT (NextAuth). Por isso `replicas: 2` é seguro. Mídia/anexos vão para **object storage S3 compatível** (variáveis `MEDIA_S3_*`), nunca no filesystem do pod.
- **Segredos fora do código/imagem (Req. 18.5):** nenhum valor de segredo aparece em ConfigMap, imagem ou nestes YAMLs. Em produção, provisione `helpdesk-secrets` via:
  - **External Secrets Operator** (AWS Secrets Manager / Vault / GCP Secret Manager) — exemplo comentado em `secret.example.yaml`;
  - **Sealed Secrets** (Bitnami) para versionar cifrado; ou
  - **CSI Secrets Store**.
- **Migrações no start (Req. 18.7, 18.8):** o `entrypoint` do `app` valida os segredos obrigatórios e roda `prisma migrate deploy` **antes** de o pod ficar *ready*. Falha de segredo ou de migração aborta o boot (o pod não entra em serviço). O `worker` **não** aplica migrações.
- **Readiness/Liveness (Req. 18.3, 19.3):** ambos os probes usam `/api/health`, que responde `503` quando uma dependência crítica (DB/fila) está indisponível — impedindo que um pod não saudável receba tráfego.

## Aplicação (exemplo)

```bash
# 1) Provisione os segredos por um mecanismo seguro (NÃO use o template direto):
#    kubectl apply -f secret.example.yaml   # apenas para laboratório/local

# 2) Config + workloads:
kubectl apply -f configmap.yaml
kubectl apply -f app-deployment.yaml
kubectl apply -f worker-deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f ingress.yaml
```

> Substitua `registry.example.com/helpdesk[-worker]:latest` pela imagem publicada no seu registry (stages `runner` e `worker` do `Dockerfile`).
