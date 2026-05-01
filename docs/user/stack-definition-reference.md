# Stack Definition YAML Reference

This reference is checked against the current stack types, validation schema, and apply-time behavior in Mini Infra.

## What this document covers

This document describes the **resolved stack definition** shape — the canonical model used by:

- Built-in template files on disk (`templates/*/template.json`)
- The `definition` field returned by `GET /api/stacks/:id`
- Internal apply-time reconciliation

It is **not** the HTTP template draft input shape. The `POST /api/stack-templates/:id/draft` endpoint accepts a different (looser) shape — most notably for `configFiles[]`, which is a top-level array on the draft body but is embedded under each service in the resolved definition. See [`services[].configFiles[]` — note about HTTP input shape](#servicesconfigfiles) below for the specific divergence.

If you are programmatically posting drafts, the source of truth is the Zod schemas in `server/src/services/stacks/stack-template-schemas.ts` (HTTP) and `server/src/services/stacks/template-file-loader.ts` (file).

## Definition shape

A stack definition is a YAML/JSON mapping with this shape:

```yaml
name: my-stack
description: Optional summary
parameters: []
resourceOutputs: []
resourceInputs: []
networks: []
volumes: []
tlsCertificates: []
dnsRecords: []
tunnelIngress: []
services: []
```

`name`, `networks`, `volumes`, and `services` are required keys. They may still be empty arrays except for `name`, which must be a non-empty string.

## Top-level fields

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `name` | Yes | Logical stack name. | 1-100 chars, `a-z`, `A-Z`, `0-9`, `_`, `-` only. |
| `description` | No | Human-readable summary. | Max 500 chars. |
| `parameters` | No | Named inputs used by parameterized fields. | Array of parameter objects. |
| `resourceOutputs` | No | Shared infra resources this stack publishes. | Array of output objects. |
| `resourceInputs` | No | Shared infra resources this stack consumes. | Array of input objects. |
| `networks` | Yes | Docker networks owned by this stack. | Array, may be empty. |
| `volumes` | Yes | Docker volumes owned by this stack. | Array, may be empty. |
| `tlsCertificates` | No | Stack-managed TLS cert definitions. | Array of TLS objects. |
| `dnsRecords` | No | Stack-managed DNS definitions. | Array of DNS objects. |
| `tunnelIngress` | No | Stack-managed tunnel ingress definitions. | Array of tunnel objects. |
| `services` | Yes | Services that make up the stack. | Array, may be empty. |

## `parameters[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `name` | Yes | Parameter key, referenced as `{{params.name}}`. | 1-100 chars, `a-z`, `A-Z`, `0-9`, `_`, `-` only. |
| `type` | Yes | Parameter type. | `string`, `number`, or `boolean`. |
| `description` | No | Help text for humans. | Max 500 chars. |
| `default` | Yes | Default parameter value. | String, number, or boolean. |
| `validation.min` | No | Parameter validation metadata. | Number. Currently stored in the definition, not enforced by stack validation/apply. |
| `validation.max` | No | Parameter validation metadata. | Number. Currently stored in the definition, not enforced by stack validation/apply. |
| `validation.pattern` | No | Parameter validation metadata. | String. Currently stored in the definition, not enforced by stack validation/apply. |
| `validation.options` | No | Parameter validation metadata. | Array of strings, numbers, or booleans. Currently stored in the definition, not enforced by stack validation/apply. |

## `resourceOutputs[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `type` | Yes | Resource type being published. | Any non-empty string. Current runtime behavior only acts on `docker-network`; other values are accepted by schema but skipped by the reconciler. |
| `purpose` | Yes | Logical lookup key used by other stacks. | Non-empty, `a-z`, `A-Z`, `0-9`, `_`, `-` only. |
| `joinSelf` | No | Whether the Mini Infra container should join this output network too. | Boolean. Only meaningful for `docker-network`. |

Runtime meaning:

- For `docker-network` outputs, Mini Infra creates a named Docker network and registers it as an infra resource.
- Environment-scoped outputs become `{environment}-{purpose}`.
- Host-scoped outputs become `mini-infra-{purpose}`.
- Non-`docker-network` outputs are currently ignored at runtime with a warning.

## `resourceInputs[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `type` | Yes | Resource type to resolve. | Any non-empty string. Current runtime behavior only resolves `docker-network`; other values are ignored. |
| `purpose` | Yes | Logical resource name to resolve. | Non-empty, `a-z`, `A-Z`, `0-9`, `_`, `-` only. |
| `optional` | No | Whether missing input is tolerated. | Boolean. Omitted means required. |

Runtime meaning:

- For `docker-network` inputs, Mini Infra resolves an environment-scoped resource first, then falls back to a host-scoped one with the same `purpose`.
- Non-`docker-network` inputs are currently ignored by the resolver.

## `networks[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `name` | Yes | Logical network name used elsewhere in the stack definition. | Any non-empty string. |
| `driver` | No | Docker network driver. | String. |
| `options` | No | Raw driver options passed through to Docker. | Mapping of string keys to any JSON values. |

Runtime meaning:

- Stack-owned Docker networks are created as `${projectName}_${name}`.

## `volumes[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `name` | Yes | Logical volume name used elsewhere in the stack definition. | Any non-empty string. |
| `driver` | No | Docker volume driver. | String. |
| `options` | No | Raw driver options passed through to Docker. | Mapping of string keys to any JSON values. |

Runtime meaning:

- Stack-owned Docker volumes are created as `${projectName}_${name}`.

## `tlsCertificates[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `name` | Yes | Logical certificate name referenced from service routing. | 1-100 chars, `a-z`, `A-Z`, `0-9`, `_`, `-` only. |
| `fqdn` | Yes | Domain name the certificate should cover. | 1-253 chars. |

## `dnsRecords[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `name` | Yes | Logical DNS record name referenced from service routing. | 1-100 chars, `a-z`, `A-Z`, `0-9`, `_`, `-` only. |
| `fqdn` | Yes | DNS name to create. | 1-253 chars. |
| `recordType` | Yes | DNS record type. | Must be `A`. |
| `target` | Yes | Target passed to Cloudflare for the A record. | Any non-empty string. |
| `ttl` | No | DNS TTL. | Integer 60-86400. If omitted, runtime default is `300`. |
| `proxied` | No | Whether Cloudflare proxying is enabled. | Boolean. If omitted, runtime default is `false`. |

## `tunnelIngress[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `name` | Yes | Logical tunnel name referenced from service routing. | 1-100 chars, `a-z`, `A-Z`, `0-9`, `_`, `-` only. |
| `fqdn` | Yes | Public hostname for the tunnel rule. | 1-253 chars. |
| `service` | Yes | Tunnel backend target string. | Any non-empty string. |

## `services[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `serviceName` | Yes | Logical service name. | 1-100 chars, `a-z`, `A-Z`, `0-9`, `_`, `-` only. |
| `serviceType` | Yes | Service behavior model. | `Stateful`, `StatelessWeb`, or `AdoptedWeb`. |
| `dockerImage` | Yes | Container image repository. | Any non-empty string. |
| `dockerTag` | Yes | Image tag. | Any non-empty string. |
| `containerConfig` | Yes | Container runtime settings. | Mapping described below. |
| `configFiles` | No | Files written into stack volumes before the service starts. | Array of config file objects. |
| `initCommands` | No | One-off commands run against stack volumes before the service starts. | Array of init command objects. |
| `dependsOn` | Yes | Declared service dependencies. | Array of strings. |
| `order` | Yes | Apply order for the service. | Integer `>= 0`. |
| `routing` | No | HTTP routing configuration. | Required when `serviceType` is `StatelessWeb` or `AdoptedWeb`. |
| `adoptedContainer` | No | Existing external container to route to. | Required when `serviceType` is `AdoptedWeb`. |

Runtime meaning of `serviceType`:

- `Stateful`: Mini Infra creates, recreates, and removes the container directly.
- `StatelessWeb`: Mini Infra performs routed blue-green deployment through HAProxy.
- `AdoptedWeb`: Mini Infra does not create or stop the container; it attaches routing to an already-running container.

Important note about `dependsOn`:

- The schema accepts it as dependency metadata, but the current reconciler uses `order` for execution ordering.

## `services[].containerConfig`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `command` | No | Container command override. | Array of strings. |
| `entrypoint` | No | Container entrypoint override. | Array of strings. |
| `capAdd` | No | Linux capabilities to add to the container. | Array of strings, e.g. `["NET_ADMIN"]`. |
| `user` | No | User the container should run as. | String. |
| `egressBypass` | No | Skip egress-firewall DNS redirection for this container. | Boolean. Treat omitted as `false`. See runtime notes below. |
| `env` | No | Static environment variables. | Mapping of string keys to string values. |
| `dynamicEnv` | No | Apply-time env values resolved by Mini Infra. | Mapping of env var name to a supported dynamic source. Keys must not overlap with `env`. |
| `ports` | No | Port exposure definitions. | Array of port objects. |
| `mounts` | No | Volume or bind mounts. | Array of mount objects. |
| `labels` | No | Extra Docker labels. | Mapping of string keys to string values. |
| `joinNetworks` | No | Extra Docker network names associated with the service. | Array of non-empty strings. Applied directly for `Stateful`, included in deployment network context for `StatelessWeb`, and currently not applied for `AdoptedWeb`. |
| `joinResourceNetworks` | No | Shared resource network purposes to join after start. | Array of non-empty strings. |
| `restartPolicy` | No | Docker restart policy. | `no`, `always`, `unless-stopped`, or `on-failure`. |
| `healthcheck` | No | Docker healthcheck config. | Mapping described below. |
| `logConfig` | No | Docker log driver config. | Mapping described below. |
| `requiredEgress` | No | Domains the service needs to reach when the egress firewall is enabled. | Array of FQDN or wildcard patterns. See runtime notes below. |

Runtime meaning of egress fields:

- `requiredEgress` entries must match either a plain FQDN (e.g. `api.example.com`) or a wildcard suffix (e.g. `*.example.com`). Each entry is auto-promoted to an `EgressRule` with `source='template'`, scoped to the declaring service. Rules only take effect in environments where `egressFirewallEnabled` is on; otherwise the entries are stored but inert.
- `egressBypass: true` tells Mini Infra to leave the container's `HostConfig.Dns` alone instead of pointing it at the per-environment egress gateway. Reserve this for sidecar/infra containers that must reach upstream DNS directly (e.g. the egress gateway itself). Most services should leave it unset.

## `services[].containerConfig.ports[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `containerPort` | Yes | Port inside the container. | Integer `1-65535` or exactly `{{params.some_name}}`. |
| `hostPort` | Yes | Host-facing port binding. | Integer `1-65535` or exactly `{{params.some_name}}`. |
| `protocol` | Yes | Network protocol. | `tcp` or `udp`. |
| `exposeOnHost` | No | Whether to bind the port on the host. | Boolean or exactly `{{params.some_name}}`. |

Important note:

- The current schema does not accept `hostPort: 0` in stack definition YAML.

## `services[].containerConfig.mounts[]`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `source` | Yes | Source volume name or bind path. | Non-empty string. |
| `target` | Yes | Mount path inside the container. | Non-empty string. |
| `type` | Yes | Mount type. | `volume` or `bind`. |
| `readOnly` | No | Whether the mount is read-only. | Boolean. |

Bind mount restriction:

- `bind` sources are rejected only when the source string, after trimming trailing slashes, exactly matches `/`, `/etc`, `/proc`, `/sys`, `/root`, `/dev`, or `/boot`.

## `services[].containerConfig.dynamicEnv`

Each key is an environment variable name. Each value must be one of:

| Value | Meaning | Constraints |
| --- | --- | --- |
| `{ kind: "vault-addr" }` | Inject the Vault address. | Exact object shape. |
| `{ kind: "vault-role-id" }` | Inject the bound Vault AppRole role ID. | Exact object shape. |
| `{ kind: "vault-wrapped-secret-id", ttlSeconds: 300 }` | Inject a wrapped secret ID minted at apply time. | `ttlSeconds` is optional, integer `> 0`. If omitted, runtime default is `300`. |
| `{ kind: "nats-url" }` | URL of the managed NATS cluster reachable from the service's network. | Exact object shape. |
| `{ kind: "nats-creds" }` | Multi-line credentials file (JWT + nkey seed) for the bound `natsRole`. **Fixed TTL — see warning below.** | Exact object shape. The service must declare a `natsRole`. |
| `{ kind: "nats-signer-seed", signer: "<name>" }` | NKey seed (base32) of the named scoped signing key, for in-process JWT minting. | `signer` must match a `nats.signers[].name` on the stack template. |
| `{ kind: "nats-account-public", signer: "<name>" }` | Public key of the NATS account that owns the named signer. Pair with `nats-signer-seed`; `nats-jwt`'s `encodeUser` requires it as the `issuer_account` claim. | `signer` must match a `nats.signers[].name` on the stack template. |

Runtime notes:

- `dynamicEnv` values are resolved at apply time, not at plan time.
- Their source definitions stay in the stack definition, but the secret values themselves are not part of the definition hash.
- **`nats-creds` is fixed-TTL.** The JWT is minted once at apply time with the credential profile's `ttlSeconds` (default `3600`) and is **not refreshed**. When the JWT expires, NATS will close the connection on the next reconnect attempt and reject all reconnects until the container is restarted (or the stack re-applied). For any service whose connection is expected to outlive the TTL — i.e. virtually every long-running service — use the **signer pattern** (`nats-signer-seed` + `nats-account-public`) and an authenticator callback that mints a fresh user JWT on connect. See [Connecting your app to NATS](/nats/app-integration) for the recipe. Reserve `nats-creds` for one-shot containers (jobs, init containers, batch tasks) whose lifetime is shorter than the TTL.

## `services[].containerConfig.healthcheck`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `test` | Yes | Docker healthcheck command array. | Array of strings. |
| `interval` | Yes | Interval between checks. | Integer `>= 1` or exactly `{{params.some_name}}`. |
| `timeout` | Yes | Timeout per check. | Integer `>= 1` or exactly `{{params.some_name}}`. |
| `retries` | Yes | Failed checks before unhealthy. | Integer `>= 1` or exactly `{{params.some_name}}`. |
| `startPeriod` | Yes | Grace period before failures count. | Integer `>= 0` or exactly `{{params.some_name}}`. |

Runtime meaning:

- These values are interpreted as seconds, then converted to Docker healthcheck timing.

## `services[].containerConfig.logConfig`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `type` | Yes | Docker log driver. | String. |
| `maxSize` | Yes | Max log file size. | String, for example `10m`. |
| `maxFile` | Yes | Max rotated file count. | String. |

## `services[].configFiles[]`

Mini Infra writes these files into the target volume before the main service container starts.

> **Heads-up — different shape on the HTTP template draft endpoint.** The fields below describe the *resolved* configFiles model, embedded inside each service. The HTTP template draft input takes `configFiles[]` as a **top-level** array (sibling of `services[]`), with `serviceName` referencing which service owns it and slightly different field names (`fileName`, `mountPath`, `owner`). See [Template draft HTTP input — `configFiles[]`](#template-draft-http-input--configfiles) below if you are posting drafts via the API.

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `volumeName` | Yes | Stack volume to write into. | Non-empty string. |
| `path` | Yes | Destination path inside that volume. | Non-empty string using only `a-z`, `A-Z`, `0-9`, `_`, `.`, `/`, `-`. |
| `content` | Yes | File contents. | String. |
| `permissions` | No | File mode. | 3 or 4 octal digits, for example `644` or `0644`. |
| `ownerUid` | No | File owner UID. | Integer `>= 0`. |
| `ownerGid` | No | File owner GID. | Integer `>= 0`. |

## Template draft HTTP input — `configFiles[]`

This section documents the alternate shape accepted by `POST /api/stack-templates/:id/draft` (and the equivalent `POST /api/stack-templates` create endpoint). It is the same logical concept — pre-start files written into a volume — but normalised into a top-level array so a single draft can describe files for multiple services without nesting.

```jsonc
{
  "networks": [...],
  "volumes":  [...],
  "services": [
    { "serviceName": "web", "serviceType": "Stateful", "...": "..." }
  ],
  "configFiles": [
    {
      "serviceName": "web",
      "fileName": "nginx.conf",
      "volumeName": "web-config",
      "mountPath": "/etc/nginx/nginx.conf",
      "content": "server { listen 80; }",
      "permissions": "0644",
      "owner": "33:33"
    }
  ]
}
```

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `serviceName` | Yes | The service this file belongs to. Must match a `services[].serviceName` in the same draft. | 1-100 chars, `a-z`, `A-Z`, `0-9`, `_`, `-` only. |
| `fileName` | Yes | Display name used in error messages and tracking. | Non-empty string. |
| `volumeName` | Yes | Stack volume to write into. | Non-empty string. |
| `mountPath` | Yes | Absolute destination path inside the volume (becomes `path` in the resolved model). | Must match `^/[a-zA-Z0-9_./-]*$` — leading slash required, no `..` traversal. |
| `content` | Yes | File contents. | String. |
| `permissions` | No | File mode. | 3 or 4 octal digits, for example `644` or `0644`. |
| `owner` | No | Combined UID:GID string (becomes `ownerUid`/`ownerGid` in the resolved model). | Format `<uid>` or `<uid>:<gid>`, e.g. `33` or `33:33`. |

The template loader merges these top-level entries into each service's `configFiles[]` at apply time. After load, the resolved snapshot uses the embedded shape documented above (with `path`, `ownerUid`, `ownerGid`).

## `services[].initCommands[]`

Mini Infra runs these in an ephemeral helper container before the main service container starts.

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `volumeName` | Yes | Stack volume to mount into the helper container. | Non-empty string. |
| `mountPath` | Yes | Mount point inside the helper container. | Safe absolute path matching `^/[a-zA-Z0-9_./-]*$`. |
| `commands` | Yes | Commands run in order. | Array of non-empty strings. |

## `services[].routing`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `hostname` | Yes | Hostname HAProxy should match. | 1-253 chars. |
| `listeningPort` | Yes | Port the service listens on. | Integer `1-65535` or exactly `{{params.some_name}}`. |
| `healthCheckEndpoint` | No | Path or endpoint used for routed health checks. | Max 500 chars. |
| `tlsCertificate` | No | Name of an item in `tlsCertificates[]`. | String. |
| `dnsRecord` | No | Name of an item in `dnsRecords[]`. | String. |
| `tunnelIngress` | No | Name of an item in `tunnelIngress[]`. | String. |
| `backendOptions` | No | HAProxy backend tuning. | Mapping described below. |

## `services[].routing.backendOptions`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `balanceAlgorithm` | No | HAProxy balance algorithm. | `roundrobin`, `leastconn`, or `source`. |
| `checkTimeout` | No | HAProxy health-check timeout. | Integer `>= 0` or exactly `{{params.some_name}}`. |
| `connectTimeout` | No | HAProxy connect timeout. | Integer `>= 0` or exactly `{{params.some_name}}`. |
| `serverTimeout` | No | HAProxy server timeout. | Integer `>= 0` or exactly `{{params.some_name}}`. |

Reference note:

- `tlsCertificate`, `dnsRecord`, and `tunnelIngress` are checked by name against the corresponding top-level arrays.
- Missing references currently produce plan warnings rather than schema validation failures.

## `services[].adoptedContainer`

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `containerName` | Yes | Name of the already-running Docker container to route to. | 1-253 chars. |
| `listeningPort` | Yes | Port Mini Infra should target on that container. | Integer `1-65535`. |

## `nats` — app-author surface (roles, signers, imports/exports)

The `nats` section lets a stack template declare its NATS topology safely
without hand-rolling NKey/JWT minting. Mini Infra materializes the
declarations into `NatsCredentialProfile` rows at apply time and binds them
to services via the symbolic refs below. This section is **separate** from
the low-level `accounts` / `credentials` / `streams` / `consumers` shape used
by built-in system templates — mixing the two within one template is
rejected at validation time. App templates use the role/signer surface.

### `nats.subjectPrefix`

The subject namespace this stack lives under. Every relative subject in
`roles[].publish` / `roles[].subscribe` / `exports[]` / `imports[].subjects`
gets this prefix prepended at apply time.

**Default:** `app.{{stack.id}}` — opaque but collision-free across stacks.

A non-default prefix (e.g. `navi`, `events.platform`) requires an admin
allowlist entry. POST `/api/nats/prefix-allowlist` with `{ prefix,
allowedTemplateIds }` to grant a template the right to claim that prefix.
The allowlist is CRUD-per-entry; subject-tree overlaps (e.g. `events` and
`events.platform`) are rejected at write time.

### `nats.roles[]`

Symbolic role declarations. Each entry materializes into a
`NatsCredentialProfile` row at apply time, with the resolved subjectPrefix
prepended to every `publish` / `subscribe` entry.

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Symbolic name. Service-level `natsRole: <name>` resolves to this. |
| `publish` | No | Subjects relative to the stack's subjectPrefix. Prepended at apply. |
| `subscribe` | No | Same shape as `publish`, for the role's subscribe permissions. |
| `inboxAuto` | No | Controls `_INBOX.>` auto-injection. Default `'both'` (right for roles that send AND respond to request/reply). Other values: `'reply'` (pub only), `'request'` (sub only), `'none'`. |
| `ttlSeconds` | No | Credential JWT TTL. Defaults to system default (3600s). |

**Subject pattern rules** (enforced at validation):
- No `>` or `*` at the start of a relative subject (would shadow the whole prefix tree).
- No leading `_INBOX.` — use `inboxAuto`.
- No leading `$SYS.` — system-account namespace is reserved.
- No empty tokens (`..` or leading/trailing dots).
- Wildcards mid-pattern (e.g. `agent.*.in`, `events.>`) are fine.

### `nats.signers[]`

Scoped signing keys for in-process JWT minting (e.g. a manager service
that mints per-user worker JWTs). The seed is delivered to the service via
`NATS_SIGNER_SEED` env var. The NATS server cryptographically constrains
anything signed with this key to the declared `subjectScope` — a
compromised signer cannot escape its sub-tree.

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Symbolic name. Service-level `natsSigner: <name>` resolves to this. |
| `subjectScope` | Yes | Subject sub-tree the key is constrained to, *relative* to the stack's subjectPrefix. E.g. `agent.worker` → minted JWTs cannot exceed `<prefix>.agent.worker.>`. No wildcards. |
| `maxTtlSeconds` | No | Hard NATS-enforced cap on JWT TTL. Default 3600. |

> **Note.** Signers depend on the live NATS account-JWT propagation
> mechanism described in the design doc (Phase 0). Until that ships,
> `signers[]` is accepted by validation but not yet materialized.

### `nats.exports[]`

Subjects relative to this stack's subjectPrefix that other stacks may
import. After apply, the resolved (prefixed) form lands in the stack's
`lastAppliedNatsSnapshot`; consumer stacks read from there.

```yaml
exports:
  - "events.>"
```

### `nats.imports[]`

Cross-stack subject sharing. Each entry resolves at apply time against the
producer's last applied snapshot.

| Field | Required | Description |
| --- | --- | --- |
| `fromStack` | Yes | Producer stack name. Scoped to the consumer's environment (cross-environment imports are not supported in v1). |
| `subjects` | Yes | Subjects relative to the *producer's* subjectPrefix. Must match one of the producer's `exports[]` patterns. |
| `forRoles` | Yes | **Required.** Roles in *this* stack that get the imported subjects added to their `subscribe` list. Per-role binding only — security-critical so a "consumer" role doesn't accidentally pick up subjects intended for a specific gateway. |

```yaml
imports:
  - fromStack: events-bus
    subjects: ["events.user.>"]
    forRoles: ["watcher"]
```

### Service bindings

Symbolic refs on `services[].natsRole` and `services[].natsSigner` resolve
at apply time:

| Field | Effect |
| --- | --- |
| `services[].natsRole: <name>` | Binds `StackService.natsCredentialId` to the materialized role profile. The injector (`nats-credential-injector.ts`) auto-injects `NATS_CREDS` and `NATS_URL` env vars. |
| `services[].natsSigner: <name>` | Auto-injects `NATS_SIGNER_SEED` env var into the service. Coexists with `natsRole` — a manager service typically has both. |

A service with both `natsRole` and `natsCredentialRef` (legacy) prefers the
role binding — but the validator rejects mixing the two surfaces in one
template, so this only applies in degenerate / corrupted-template states.

### Worked example (slackbot-style topology)

```yaml
nats:
  # subjectPrefix omitted → defaults to "app.{{stack.id}}"
  roles:
    - name: gateway
      publish:   ["agent.in"]
      subscribe: ["slack.api", "askuser", "agent.reply.>"]
      # inboxAuto defaults to 'both'
    - name: manager
      publish:   ["agent.worker.>"]
      subscribe: ["agent.ensure", "agent.worker.ready.>"]
  signers:
    - name: worker-minter
      subjectScope: "agent.worker"
      maxTtlSeconds: 2400

services:
  - name: slack-gateway
    natsRole: gateway
  - name: manager
    natsRole: manager           # → NATS_CREDS (connection)
    natsSigner: worker-minter   # → NATS_SIGNER_SEED (in-process minting)
```

## Templating notes

Mini Infra resolves templates from a context that includes:

- `stack.id` — the stack's database ID. Available at apply time (after instantiate), not at template publish time. Useful for services that call back into the Mini Infra API and need to identify their own stack — e.g. `MINI_INFRA_STACK_ID: '{{stack.id}}'` in a service `env`.
- `stack.name` — the stack's logical name.
- `stack.projectName` — the Docker project prefix. Resolves to `{envName}-{stackName}` for environment-scoped stacks and `mini-infra-{stackName}` for host-level stacks.
- `environment.id`, `environment.name`, `environment.type`, `environment.networkType` — environment metadata. **Only available for environment-scoped stacks.** Referencing `{{environment.*}}` in a host-scoped template throws "Unresolved template variable" at apply time.
- `services.<serviceName>.containerName` — the full Docker container name, e.g. `prod-mystack-web`.
- `services.<serviceName>.image` — the resolved image reference, e.g. `nginx:1.25`.
- `env.<VAR_NAME>` — static container env vars aggregated from `containerConfig.env` across **all services** in definition order. If two services define the same key, the later one wins. Distinct from `environment.*` above, which carries Mini Infra environment metadata.
- `volumes.<volumeName>` — the actual Docker volume name, `{projectName}_{volumeName}`.
- `networks.<networkName>` — the actual Docker network name, `{projectName}_{networkName}`.
- `params.<paramName>` — resolved parameter values.

Important limits:

- For numeric and boolean typed fields that support parameters, the template must be the entire value and must reference `{{params.<name>}}` only. The narrow regex on these fields rejects other namespaces because they would never coerce to a number.
- Free-form string fields (e.g. `containerConfig.env` values, `command`, `mounts.source`, `configFiles[].content`) can contain template expressions because service definitions are resolved recursively at apply time. Any of the namespaces above can be used here.
