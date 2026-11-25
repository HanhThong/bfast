# The Kubernetes provider (not implemented yet)

`"provider": "k8s"` exists in the configuration and the provider registry, but it is a
stub: its availability check reports *not implemented*, and no operation runs. This
document records the contract the real implementation will follow — so manifests written
today will drop in when it lands — and the questions still open.

The base contract is the same one the compose provider satisfies
([docker-compose.md](docker-compose.md)): one environment per ticket — or the master
environment for the workspace itself — started from scratch, isolated from its siblings,
fed the same environment variables (`portVariables` + `BFAST_TICKET_ID` +
`BFAST_PROJECT_NAME`). Only the mapping changes:

| Compose concept | K8s equivalent |
|---|---|
| Project name (`descriptor.projectName`: `bfast-<id>`, `bfast-master-<workspace>`) | **Namespace** of the same name |
| `up -d --build --force-recreate` | Build/tag images from the worktree, apply manifests, restart rollout |
| `down` | Scale the namespace's workloads down (PVCs kept) |
| `down --volumes` | Delete the namespace (PVCs included) |
| `compose ls` | One API query for Deployment readiness across `bfast-*` namespaces |
| Port variables | Substituted into the manifests (helm values / kustomize / envsubst — TBD) |
| Healthcheck | Readiness probe |

One rule the readiness query must carry, because scale-to-zero makes a Deployment
*vacuously* ready: a workload with desired replicas `0` reads as **stopped**; **running**
means every workload has desired `> 0` and all replicas ready; a mix maps to **partial**
— mirroring the compose provider's running/exited/absent semantics.

## Authoring manifests today

Write them so they will satisfy the contract later:

- **Everything namespaced.** No cluster-scoped resources with fixed names (ClusterRoles,
  CRDs, static PV names) created per environment — two namespaces must coexist.
- **Ports as values, not literals.** Package as a helm chart or kustomize overlay under
  `k8s/`, taking the same port variable names as inputs — they may surface as NodePorts,
  ingress rules, or port-forward targets per environment (see Open questions). Never
  hard-code a `nodePort`.
- **Images built from the repo**, tagged per branch/ticket — never a shared `:latest`.
- **Idempotent seeds** as Jobs safe to re-run; **readiness probes** on every Deployment —
  that is what "running" will be read from.
- **Disposable PVCs** — Delete removes the namespace and its claims.

## Why this will drop in without changes elsewhere

The [`EnvironmentProvider` seam](provider-interface.md) hands a provider only the
environment's descriptor — id, project name, the folder to run in, allocated ports — and lets it
substitute those however its technology needs. A chart that treats ports and namespace as
inputs is already shaped for it; nothing in the sidebar or the store changes when the k8s
provider becomes real. The configuration block may gain k8s-specific fields (see the open
questions), but the existing fields keep their meaning.

## Open questions (decided when implementation starts)

- **Exposing ports:** NodePort per environment vs `kubectl port-forward` held by the
  extension. Port-forward matches the allocated-port model exactly but ties the stack's
  reachability to the VS Code session. NodePort survives it but constrains the range:
  Kubernetes' default NodePort range is **30000–32767**, which excludes BFAST's default
  `20000–20999` — choosing NodePort means changing `portRangeStart`/`portRangeEnd` or the
  cluster's `--service-node-port-range`.
- **Substitution mechanism:** helm `--set`/values file vs kustomize vs envsubst over plain
  manifests — likely a `k8sManifests`-style setting naming the chart/overlay path.
- **Cluster/context selection:** which kubeconfig context an environment targets, and
  whether that is per-workspace configuration or per-machine.
- **Image building:** local builds require the cluster to see the local registry (kind,
  minikube, Docker Desktop differ); may need a configurable build/push step.
