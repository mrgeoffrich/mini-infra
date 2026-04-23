# Stack Definition YAML Reference

This reference is checked against the current stack types, validation schema, and apply-time behavior in Mini Infra.

A stack definition is a YAML mapping with this shape:

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
| `user` | No | User the container should run as. | String. |
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

Runtime notes:

- `dynamicEnv` values are resolved at apply time, not at plan time.
- Their source definitions stay in the stack definition, but the secret values themselves are not part of the definition hash.

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

| Field | Required | Meaning | Constraints |
| --- | --- | --- | --- |
| `volumeName` | Yes | Stack volume to write into. | Non-empty string. |
| `path` | Yes | Destination path inside that volume. | Non-empty string using only `a-z`, `A-Z`, `0-9`, `_`, `.`, `/`, `-`. |
| `content` | Yes | File contents. | String. |
| `permissions` | No | File mode. | 3 or 4 octal digits, for example `644` or `0644`. |
| `ownerUid` | No | File owner UID. | Integer `>= 0`. |
| `ownerGid` | No | File owner GID. | Integer `>= 0`. |

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

## Templating notes

Mini Infra resolves templates from a context that includes:

- `stack.name`
- `stack.projectName`
- `services.<serviceName>.containerName`
- `services.<serviceName>.image`
- `env.<VAR_NAME>`
- `volumes.<volumeName>`
- `networks.<networkName>`
- `params.<paramName>`

Important limits:

- For numeric and boolean typed fields that support parameters, the template must be the entire value, for example `{{params.port}}`.
- Free-form string fields can contain template expressions because service definitions are resolved recursively at apply time.
- `configFiles[].content` is also template-resolved before being written.
