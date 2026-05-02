# Service Addons

A declarative system for attaching cross-cutting capabilities — Tailscale SSH, Tailscale web exposure, Caddy-based auth gating — to any service in a stack by adding one or more entries to an `addons:` block in the service definition. Each addon is defined as a self-contained directory of declarative manifests, compose-fragment templates, and a small amount of bespoke TypeScript for apply-time provisioning. The first three addons shipped under this framework are `tailscale-ssh`, `tailscale-web`, and `caddy-auth`.

Status: **planned, not implemented**.

## Related documents

- [stack-service-pools-plan.md](../shipped/stack-service-pools-plan.md) — Pool services. Addons must be applied per pool instance at spawn time, not just at stack apply.
- [auth-proxy-sidecar-plan.md](auth-proxy-sidecar-plan.md) — **Different feature.** The existing auth-proxy is an *outbound* forward proxy holding API keys for Anthropic / GitHub / Google. The `caddy-auth` addon in this doc is an *inbound* user-auth gate (OIDC sign-in for end-users hitting a service). Naming intentionally avoids collision: `caddy-auth`, not `auth-proxy`.
- [stack-definition-reference.md](../../user/stack-definition-reference.md) — stack schema this feature extends.
- [docs/user/wsl2-reference.md](../../user/wsl2-reference.md) — Tailscale sidecar requires `NET_ADMIN` + `/dev/net/tun`; relevant for the WSL2 dev driver.

## Motivation

Three independent feature requests share the same shape:

1. **Tailscale SSH access** — operators want to SSH into managed containers without exposing port 22 publicly or distributing keys. Tailscale handles auth via the tailnet identity provider; the container just needs a Tailscale sidecar.
2. **Tailscale web exposure** — internal tools (status pages, admin UIs) want a friendly `https://<service>-<env>.<tailnet>.ts.net` URL that's reachable from any tailnet-joined laptop, with auto-provisioned Let's Encrypt certs and no Cloudflare tunnel involvement.
3. **Inbound auth gating** — services that don't speak OIDC themselves want a reverse-proxy in front of them that does, gated on a user's IdP identity, with group-based ACLs.

All three are "wrap a service with a sidecar that handles network ingress concerns." Without a framework, we'd grow three bespoke code paths plus three bespoke template fields. The Service Addons system makes adding a fourth (e.g. log shipping, volume backup, Prometheus exporter) a matter of dropping a directory in `server/src/services/stack-addons/`.

User-friendliness was an explicit design pressure: **adding an addon to a service must be one line of YAML, and connecting to the resulting service from a developer laptop must be effectively zero-config** (Tailscale handles identity, MagicDNS handles hostnames, the UI surfaces the URL).

## Goals

1. A new `addons:` block on `StackServiceDefinition` accepting a map of addon-id → addon-config. `addons: { tailscale-ssh: {} }` is the minimum-viable form.
2. Each addon is one directory under `server/src/services/stack-addons/<id>/` containing a `manifest.yaml`, a compose-fragment template, and a TypeScript module for hooks.
3. Apply-time pipeline: addons contribute compose fragments, env injections, and pre-apply provisioning steps (e.g. minting a Tailscale authkey) that are merged into the rendered stack before reconciliation.
4. **Pool integration** — addons declared on a `Pool`-type service are evaluated per **instance** at spawn time, not at apply time. Each pool instance gets its own sidecar, its own Tailscale identity, and its own per-instance hostname.
5. **Tailscale becomes a Connected Service** in Mini Infra alongside Docker / Azure / Cloudflare / GitHub, with credential storage in Vault, status probing, and an admin UI.
6. The first three shipped addons cover the immediate use cases: `tailscale-ssh`, `tailscale-web`, `caddy-auth`.

## Non-goals

- **Multi-tailnet support.** v1 binds Mini Infra to one tailnet via one OAuth client. Operators with multiple tailnets are out of scope.
- **Per-user ACL provisioning.** v1 writes a single ACL bootstrap snippet that the operator pastes into their tailnet policy file. We do not call the Tailscale ACL API; users edit ACL JSON themselves.
- **Tailscale Funnel (public exposure).** v1 ships `tailscale-web` in tailnet-only mode. Funnel adds a security surface (port 443 on the public internet) that competes with the existing Cloudflare tunnel feature. Deferred to v2.
- **Full OIDC integration in `caddy-auth`.** v1 ships the Caddy sidecar with a Caddyfile that reads provider config from a mounted file; UI for managing IdPs and the underlying `OidcProvider` model are deferred to v2. The addon is shippable as "operator manually edits the Caddyfile" in v1.
- **Cross-stack addon composition.** Addons are scoped to one service in one stack. No "this addon depends on an addon on another stack."
- **Custom user-defined addons.** Only addons in the registry are usable; we don't expose addon authoring as a user feature.

## Concepts

**Service Addon** — a named capability that wraps a service with one or more sidecars and contributes provisioning steps. Identified by a stable string (`tailscale-ssh`). Defined in the addon registry. The unit of opt-in is `addons.<id>: {…config}` on a service.

**Addon manifest** — `manifest.yaml` declaring the addon's identity, description, configuration schema (Zod-flavored JSON), connected-service prerequisites, applicability (which `serviceType`s it supports), and merge rules with other addons.

**Addon kind** — an optional grouping label in the manifest. When two addons of the same `kind` are declared on the same service, the runtime merges them into a single sidecar rather than spawning two. `tailscale-ssh` and `tailscale-web` share `kind: tailscale`; the runtime emits one `tailscale` sidecar with combined config when both are enabled.

**Compose fragment** — `compose.yaml.tmpl`: a Mustache-templated docker-compose snippet rendered per service-addon application. Variables include `{{service.name}}`, `{{stack.id}}`, `{{env.name}}`, `{{addon.config.*}}`, and addon-provisioned values like `{{provisioned.authkey}}`.

**Provision hook** — `provision.ts` module exporting an async function called *before* compose rendering. Receives the service definition + addon config; returns a `ProvisionedValues` map merged into the template context. This is where Tailscale authkeys are minted, Caddyfiles rendered, and per-instance secrets generated.

**Service-addon application** — the runtime pairing of (one service, one addon, one config blob). For static services this is computed once at apply; for pool services it's computed once per instance at spawn.

**Tailscale Connected Service** — the existing `ConnectedService` model gains a new `tailscale` type. Stores OAuth client_id + client_secret in Vault, tailnet domain (e.g. `tail-cafe123.ts.net`), and connectivity probe state.

## Architecture

### File layout

```
server/src/services/stack-addons/
├── addon-registry.ts             # imports + registers each addon directory
├── addon-types.ts                # Addon, AddonManifest, ProvisionContext interfaces
├── addon-runtime.ts              # apply-time pipeline: validate → provision → render → merge
├── addon-template.ts             # Mustache rendering helper
├── tailscale/
│   ├── shared/
│   │   ├── mint-authkey.ts       # OAuth client_credentials → POST /api/v2/tailnet/-/keys
│   │   └── hostname.ts           # `<service>-<env>` builder, sanitisation, length cap
│   └── README.md
├── tailscale-ssh/
│   ├── manifest.yaml
│   ├── compose.yaml.tmpl
│   ├── provision.ts              # imports from ../tailscale/shared
│   └── status.ts                 # device-online lookup for UI
├── tailscale-web/
│   ├── manifest.yaml
│   ├── compose.yaml.tmpl
│   ├── serve.json.tmpl           # tailscale serve config
│   ├── provision.ts
│   └── status.ts
└── caddy-auth/
    ├── manifest.yaml
    ├── compose.yaml.tmpl
    ├── Caddyfile.tmpl
    ├── provision.ts
    └── status.ts
```

Sidecar Docker images:

- **Tailscale**: pulled from upstream `tailscale/tailscale:latest`. Pinned major version in the manifest for reproducibility.
- **Caddy**: a small Mini-Infra-built image at `caddy-auth-sidecar/`, mirroring the layout of `update-sidecar/` and `agent-sidecar/`. Built and published as `mini-infra/caddy-auth:<tag>`. The image bundles the `caddy-security` plugin and the Caddyfile template; runtime config is mounted.

### Addon interface

```ts
// server/src/services/stack-addons/addon-types.ts

export interface AddonManifest {
  id: string;                      // "tailscale-ssh"
  kind?: string;                   // "tailscale" — addons sharing a kind merge sidecars
  description: string;
  configSchema: z.ZodTypeAny;      // validates the addon config blob
  appliesTo: StackServiceType[];   // ["Stateful", "StatelessWeb", "Pool"]
  requiresConnectedService?: ConnectedServiceType;  // "tailscale"
  sidecarMergeStrategy?: "shared-tailscale" | "standalone";
}

export interface ProvisionContext {
  stack: { id: string; name: string };
  service: { name: string; type: StackServiceType };
  environment: { id: string; name: string; networkType: "Local" | "Internet" };
  addonConfig: unknown;            // already validated against manifest.configSchema
  instance?: { instanceId: string };  // present iff Pool instance spawn
  vault: VaultClient;
  connectedServices: ConnectedServiceLookup;
}

export interface ProvisionedValues {
  envForSidecar?: Record<string, string>;
  envForTargetService?: Record<string, string>;
  files?: Array<{ path: string; contents: string; mode?: number }>;
  templateVars: Record<string, unknown>;  // available as {{provisioned.*}} in compose.yaml.tmpl
}

export interface AddonModule {
  manifest: AddonManifest;
  provision(ctx: ProvisionContext): Promise<ProvisionedValues>;
  status?(ctx: StatusContext): Promise<AddonStatus>;
  cleanup?(ctx: ProvisionContext): Promise<void>;  // pool instance teardown, ephemeral key revocation
}
```

### Apply-time pipeline

For each `(service, addon)` pair on a non-Pool service:

1. **Validate.** Manifest's `configSchema` parses the user-supplied addon config. Failures surface in stack validation alongside other definition errors.
2. **Check applicability.** Reject if `serviceType` not in `appliesTo`. Reject if `requiresConnectedService` not configured / not connected.
3. **Resolve merge groups.** Group addons by `kind`. For each group of size > 1, merge configs (manifest-defined merge function — for `tailscale`, the merge produces `{ ssh: bool, serve: ServeConfig | null }`).
4. **Provision.** Call each addon's `provision()` (or merged-group provision). Returns `ProvisionedValues`.
5. **Render compose fragment.** Mustache-render `compose.yaml.tmpl` with `{ service, stack, env, addon, provisioned, instance? }`.
6. **Merge.** The rendered fragment is spliced into the stack's compose:
   - If the addon contributes a sidecar, append its service entry under `services:` with name `addon-<addon-id>-<service-name>` (or `addon-<kind>-<service-name>` for merged groups).
   - The target service's `network_mode` is overwritten to `service:<sidecar-name>`. Original `ports:` exposure is removed (Tailscale or Caddy now owns ingress) — except for ports the addon explicitly preserves.
   - `envForTargetService` entries are merged into the target service's env.
7. **Apply.** Reconciler proceeds as normal with the augmented compose.

### Pool spawn pipeline

For Pool services with addons declared, the per-instance flow extends the spawn path described in `stack-service-pools-plan.md`:

1. POST `/pools/.../instances` triggers spawn.
2. **Pre-spawn addon provisioning** runs *before* container creation. Each addon's `provision()` is called with `instance: { instanceId }` in context. Tailscale authkey minting happens here, scoped per-instance.
3. **Per-instance sidecar containers** are created: container name `{stack-name}-pool-{service-name}-{instanceId}-addon-{kind}`. Same labels as the pool instance container plus `mini-infra.addon = <kind>`.
4. **Sidecar starts first**, target instance container second with `network_mode: container:<sidecar-id>`.
5. **Reaper extension.** When the pool instance is reaped (idle, error, manual stop), the reaper iterates addon containers attached to that instance and calls `cleanup()` on each addon module — for Tailscale, `cleanup()` is a no-op (ephemeral nodes auto-remove from the tailnet). For other addons (e.g. future ones holding state), this hook lets them tear down resources.

This means addon containers double the container count for pools — a 50-instance worker pool with `tailscale-ssh` runs 100 containers. Worth noting in the addon's documentation; not a blocker.

### Hostname convention

| Service shape | Hostname (TS_HOSTNAME) |
|---|---|
| Static (`Stateful`, `StatelessWeb`) | `{service-name}-{env-name}` |
| Pool instance | `{service-name}-{env-name}-{instance-id-sanitised}` |
| Pool instance, instanceId longer than fits | `{service-name}-{env-name}-{instance-id-sha256[:8]}` |

Sanitisation: `[a-z0-9-]`, lowercased, leading/trailing hyphens stripped, max 63 chars (DNS label limit). Implemented in `tailscale/shared/hostname.ts`.

This hostname becomes:
- The Tailscale device name (visible in tailnet admin console).
- The MagicDNS short name (`worker-prod-u12345`).
- The MagicDNS HTTPS hostname for `tailscale-web`: `worker-prod-u12345.{tailnet-domain}.ts.net`.

## Tailscale Connected Service

Adds `Tailscale` to the `ConnectedServiceType` enum. New entry in the connected-services UI alongside Docker, Azure Storage, Cloudflare, GitHub.

### Configuration (admin UI)

| Field | Storage | Purpose |
|---|---|---|
| `oauthClientId` | DB column | Identifies the OAuth client in tailnet |
| `oauthClientSecret` | Vault `secret/connected-services/tailscale/oauth-client-secret` | Used for `client_credentials` token exchange |
| `tailnetDomain` | DB column | e.g. `tail-cafe123.ts.net`. Auto-populated from the first successful API call (`GET /api/v2/tailnet/-/devices` reveals it). Editable. |
| `defaultTags` | DB column (JSON array) | Tags appended to every minted authkey. Default: `["tag:mini-infra-managed"]` |
| `aclBootstrapSnippet` | Read-only computed | Click-to-copy ACL JSON the operator pastes into their tailnet policy. Includes `tagOwners` and the `ssh` stanza. |

### Connectivity probe

`ConnectedServiceProber` gains a `tailscale` case: exchange OAuth credentials for an access token, call `GET /api/v2/tailnet/-/devices?fields=default`. Sets connectivity status (connected / failed / timeout / unreachable) and response time using the existing pattern.

### ACL bootstrap snippet

The settings page renders this (with the operator's chosen default tags substituted):

```json
{
  "tagOwners": {
    "tag:mini-infra-controller": [],
    "tag:mini-infra-managed": ["tag:mini-infra-controller"]
  },
  "ssh": [
    {
      "action": "check",
      "src": ["autogroup:member"],
      "dst": ["tag:mini-infra-managed"],
      "users": ["root", "autogroup:nonroot"],
      "checkPeriod": "12h"
    }
  ]
}
```

A short admin-doc page (`docs/user/connected-services-tailscale.md`) walks through OAuth client creation, scopes (`auth_keys` + `devices`, write), tagging the OAuth client with `tag:mini-infra-controller`, and pasting the ACL snippet.

### Authkey minting

`server/src/services/connected-services/tailscale/authkey-minter.ts`:

```ts
async function mintAuthkey(opts: {
  tags: string[];
  ephemeral: boolean;
  expirySeconds: number;
}): Promise<{ key: string; id: string }> {
  const accessToken = await getAccessToken();  // cached, refreshed on 401
  const res = await fetch(`https://api.tailscale.com/api/v2/tailnet/-/keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: opts.ephemeral,
            preauthorized: true,
            tags: opts.tags,
          },
        },
      },
      expirySeconds: opts.expirySeconds,
    }),
  });
  // … error handling → key, id
}
```

OAuth access token is short-lived (~1h); cache in memory with a 5-minute pre-expiry refresh. Key minting is idempotent-by-design — even if the same call runs twice, ephemeral nodes auto-clean up.

## Stack definition changes

### `addons` block on `StackServiceDefinition`

```yaml
services:
  - serviceName: api
    serviceType: StatelessWeb
    dockerImage: my-org/api
    ...
    addons:
      tailscale-ssh: {}
      tailscale-web:
        port: 8080
      caddy-auth:
        provider: entra
        allowedGroups: ["sre", "engineers"]
```

The `addons` block is a YAML map: keys are addon IDs, values are addon-specific config blobs (validated against each addon's `configSchema`).

### Schema touch points

1. `lib/types/stacks.ts`:
   - Add `addons` field to `stackServiceDefinitionSchema` (Zod): `z.record(z.string(), z.unknown()).optional()`. Per-addon schema validation runs in a `superRefine` step that resolves each key against the registered addon manifests.
2. `server/prisma/schema.prisma`:
   - No new column on `StackService`. Addon config lives inside the existing `serviceConfig` JSON blob alongside `containerConfig`. Migration only needed when an addon needs persistent per-service state (none in v1).
3. `server/src/services/stacks/schemas.ts`:
   - `superRefine` calls into `validateAddonsBlock(addonsMap, serviceType, connectedServices)`. Surfaces per-addon validation errors with paths like `addons.tailscale-ssh.tag`.

### Compose rendering integration

`StackComposeBuilder` (the existing module that translates a stack definition into a compose document) gets a new step after service rendering:

```
build services → buildAddonContributions(stackDef) → mergeAddons(composeDoc)
```

`buildAddonContributions` invokes the addon runtime for every `(service, addon)` pair, collecting compose fragments and target-service mutations. `mergeAddons` applies them deterministically (sorted by service name then addon id, so output is stable).

## Addon: tailscale-ssh

**Manifest:**

```yaml
id: tailscale-ssh
kind: tailscale
description: SSH into the service via your tailnet, authenticated by the tailnet IdP.
appliesTo: [Stateful, StatelessWeb, Pool]
requiresConnectedService: tailscale
configSchema:
  type: object
  properties:
    extraTags:
      type: array
      items: { type: string, pattern: "^tag:[a-z][a-z0-9-]*$" }
  additionalProperties: false
sidecarMergeStrategy: shared-tailscale
```

**Provision:**

1. Mint an ephemeral, single-use, preauthorized authkey with tags `["tag:mini-infra-managed", "tag:stack-{stackId}", "tag:env-{envName}", "tag:service-{serviceName}", ...extraTags]`. `expirySeconds: 600` (only needs to live until container start).
2. Return `templateVars: { authkey, hostname, ssh: true }` and `envForSidecar: { TS_AUTHKEY, TS_HOSTNAME }`.

**Compose fragment** (rendered when `tailscale-ssh` is the only `tailscale`-kind addon on the service):

```yaml
services:
  addon-tailscale-{{service.name}}:
    image: tailscale/tailscale:latest
    hostname: {{provisioned.hostname}}
    environment:
      TS_AUTHKEY: {{provisioned.authkey}}
      TS_HOSTNAME: {{provisioned.hostname}}
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
      TS_EXTRA_ARGS: "--ssh"
    volumes:
      - addon-ts-{{service.name}}-state:/var/lib/tailscale
    cap_add: [NET_ADMIN, NET_RAW]
    devices: [/dev/net/tun]
    restart: unless-stopped
volumes:
  addon-ts-{{service.name}}-state:
```

**End-user experience:**

```bash
# One-time on laptop:
brew install tailscale && tailscale up

# Any time:
ssh root@api-prod
# First connection of the day pops a browser tab for IdP re-auth (12h checkPeriod).
```

The Mini Infra UI's stack detail page lists every Tailscale-attached service with a "Copy ssh command" button.

## Addon: tailscale-web

**Manifest:**

```yaml
id: tailscale-web
kind: tailscale
description: Expose the service over your tailnet at https://<hostname>.<tailnet>.ts.net with auto-provisioned TLS.
appliesTo: [Stateful, StatelessWeb, Pool]
requiresConnectedService: tailscale
configSchema:
  type: object
  required: [port]
  properties:
    port:
      type: integer
      minimum: 1
      maximum: 65535
      description: Local container port to expose over Tailscale HTTPS.
    path:
      type: string
      default: "/"
      description: URL path prefix to mount the service at.
  additionalProperties: false
sidecarMergeStrategy: shared-tailscale
```

**Provision:**

1. Resolve the tailnet domain from the Tailscale connected service. Build the FQDN: `{hostname}.{tailnetDomain}.ts.net`.
2. Render `serve.json` from `serve.json.tmpl`:
   ```json
   {
     "TCP": { "443": { "HTTPS": true } },
     "Web": {
       "${TS_CERT_DOMAIN}:443": {
         "Handlers": { "{{addon.config.path}}": { "Proxy": "http://127.0.0.1:{{addon.config.port}}" } }
       }
     }
   }
   ```
3. Return `templateVars: { serveConfigPath: "/config/serve.json", url: "https://{fqdn}{path}" }` and `files: [{ path: "serve.json", contents: <rendered> }]`.
4. Mint an authkey (same as `tailscale-ssh`).

**When merged with `tailscale-ssh`:** the runtime emits one sidecar with both `--ssh` in `TS_EXTRA_ARGS` and `TS_SERVE_CONFIG=/config/serve.json` in environment, sharing one authkey, one hostname, one state volume.

**End-user experience:** open `https://api-prod.<tailnet>.ts.net` in the browser. Tailscale handles certs invisibly. No login prompt because tailnet identity is the gate.

## Addon: caddy-auth

**Manifest:**

```yaml
id: caddy-auth
description: Caddy-based reverse proxy that gates the service on OIDC sign-in.
appliesTo: [StatelessWeb, Pool]
configSchema:
  type: object
  required: [provider, upstreamPort]
  properties:
    provider:
      type: string
      description: Symbolic IdP id; resolved via the OidcProvider table (v2). v1 reads provider config from a Vault path.
    upstreamPort:
      type: integer
    allowedGroups:
      type: array
      items: { type: string }
    publicPaths:
      type: array
      items: { type: string }
      description: Paths that bypass the auth gate (e.g. /healthz).
  additionalProperties: false
```

**Provision:**

1. Read OIDC provider config from Vault at `secret/connected-services/oidc/{provider}` (client_id, client_secret, issuer, redirect_uri base).
2. Render `Caddyfile.tmpl`:
   ```
   {
     order authenticate before respond
   }

   :8443 {
     route /healthz { respond "ok" 200 }
     {{#each publicPaths}}
     route {{this}} { reverse_proxy 127.0.0.1:{{addon.config.upstreamPort}} }
     {{/each}}

     authenticate with myportal {
       providers.oauth2.{{addon.config.provider}} {
         client_id {{provisioned.clientId}}
         client_secret {{provisioned.clientSecret}}
         scopes openid email profile groups
         user_attribute groups
       }
     }

     authorize {
       allow groups {{join addon.config.allowedGroups ","}}
     }

     reverse_proxy 127.0.0.1:{{addon.config.upstreamPort}}
   }
   ```
3. Return `files: [{ path: "Caddyfile", contents: <rendered> }]` and `templateVars: { upstream: "127.0.0.1:{port}" }`.

**Compose fragment:**

```yaml
services:
  addon-caddy-auth-{{service.name}}:
    image: mini-infra/caddy-auth:latest
    network_mode: service:addon-tailscale-{{service.name}}  # if tailscale-web is also enabled
    # OR: ports: ["443:8443"] if standalone
    volumes:
      - {{provisioned.caddyfilePath}}:/etc/caddy/Caddyfile:ro
    restart: unless-stopped
```

**Composition with Tailscale.** When both `tailscale-web` and `caddy-auth` are enabled on a service, the addon runtime orders sidecars deterministically:

```
tailscale-web sidecar (terminates HTTPS on port 443 → forwards to 127.0.0.1:8443)
        ↓
caddy-auth sidecar (gates auth on port 8443 → forwards to 127.0.0.1:upstreamPort)
        ↓
target service (listens on upstreamPort)
```

All three share the same netns (the tailscale sidecar's). The `tailscale-web` serve.json is rewritten to point at `127.0.0.1:8443` instead of `127.0.0.1:upstreamPort` when `caddy-auth` is detected on the same service.

**v1 → v2 boundary.** v1 ships the Caddy sidecar runnable; OIDC config lives in Vault and is edited by the operator directly. v2 adds an `OidcProvider` table, an admin UI for managing IdPs, and `OidcProvider` entries in connected services. The addon manifest doesn't change between v1 and v2 — only the resolution of `addon.config.provider` does.

## Connect panel UI

A new "Connect" tab on the stack detail page surfaces every addon-attached endpoint:

| Service | Address | Action |
|---|---|---|
| api (production) | `ssh root@api-prod` | Copy |
| api (production) | `https://api-prod.tail-cafe123.ts.net` | Open / Copy |
| worker (production) | `ssh root@worker-prod-u12345` _(per-instance, when pool is expanded)_ | Copy |

For `Pool` services the row expands to show running instances. Each instance shows its instance-specific hostname.

This is the user-friendliness pay-off: nobody has to remember the hostname convention or compose `ssh` commands manually.

## Permissions

Addons read from the same RBAC surface as their target features. No new top-level permission domain. Specifically:

- `stacks:write` is required to add or remove addons (it's a stack-definition change).
- `connected-services:write` is required to configure the Tailscale connected service.
- The addon framework itself is invisible to the permission system — addons are an implementation detail of stacks.

## Socket.IO events

Two new addon-specific events on the existing `stacks` channel:

| `ServerEvent` constant | String value | Payload |
|---|---|---|
| `STACK_ADDON_PROVISIONED` | `"stack:addon:provisioned"` | `{ stackId, serviceName, addonId, instanceId? }` |
| `STACK_ADDON_FAILED` | `"stack:addon:failed"` | `{ stackId, serviceName, addonId, instanceId?, error }` |

These let the UI show progress when an addon is mid-provision (e.g. minting a Tailscale authkey can take 1-2 seconds against the API).

For `tailscale` addons specifically, a `Tailscale` channel exposes device status:

| `ServerEvent` constant | String value | Payload |
|---|---|---|
| `TAILSCALE_DEVICE_ONLINE` | `"tailscale:device:online"` | `{ stackId, serviceName, instanceId?, hostname, deviceId }` |
| `TAILSCALE_DEVICE_OFFLINE` | `"tailscale:device:offline"` | `{ stackId, serviceName, instanceId?, hostname }` |

A scheduler polls `GET /api/v2/tailnet/-/devices` every 60s and emits transitions.

## Out of scope

- **Multi-tailnet.** One Tailscale connected service per Mini Infra instance.
- **Funnel (public exposure via Tailscale).** Defer to v2.
- **OIDC provider management UI.** v1 reads Caddy auth config from Vault; admin edits it directly.
- **User-defined addons.** Only registry-shipped addons.
- **Per-route Caddy config.** Caddy is configured per-service, not per-route. Multi-route services use Caddy's own routing within the rendered Caddyfile.
- **Auto-managing the tailnet ACL.** v1 emits a copy-paste snippet; we do not call the ACL API.
- **Cross-stack addon references.** Addons are local to one service in one stack.
- **Drift detection on addon-provisioned resources.** A reconciler that detects "this Tailscale device exists in the tailnet but no longer corresponds to a running container" is deferred. Ephemeral nodes self-clean, so the leak is bounded.

## Implementation phases

### Phase 1 — addon framework foundation + Tailscale Connected Service + tailscale-ssh

- `lib/types/connected-services.ts`: add `"tailscale"` to `ConnectedServiceType` union.
- `server/prisma/schema.prisma`: extend `ConnectedService` with `oauthClientId`, `tailnetDomain`, `defaultTags`. Migration + Vault path convention for `oauth-client-secret`.
- `server/src/services/connected-services/tailscale/`: connectivity prober + authkey minter + token cache.
- `server/src/services/stack-addons/`: `addon-types.ts`, `addon-registry.ts`, `addon-runtime.ts`, `addon-template.ts`.
- `server/src/services/stack-addons/tailscale-ssh/`: manifest + compose fragment + provision module.
- `server/src/services/stacks/schemas.ts`: `addons` field + `superRefine` validation.
- `server/src/services/stacks/stack-compose-builder.ts`: `mergeAddons` step.
- `lib/types/socket-events.ts`: `STACK_ADDON_PROVISIONED`, `STACK_ADDON_FAILED`, Tailscale channel constants.
- `client/src/pages/connected-services/`: Tailscale settings page with ACL bootstrap snippet.
- Unit tests: addon runtime, hostname sanitisation, authkey-minting (mocked HTTP), schema validation, end-to-end addon-pipeline render.

This phase ships the framework and the simplest addon. Operators can SSH into stack containers via Tailscale.

### Phase 2 — tailscale-web and addon merging

- `server/src/services/stack-addons/tailscale-web/`: manifest + compose fragment + serve.json template + provision module.
- `addon-runtime.ts`: merge logic for shared-`kind` addons (`tailscale-ssh` + `tailscale-web` → one sidecar).
- `client/src/pages/stack-detail/connect-panel.tsx`: lists addon-attached endpoints with copy-to-clipboard.
- Polling loop for `TAILSCALE_DEVICE_ONLINE` / `OFFLINE` events.
- Tests: merged-config rendering, serve.json rendering, end-to-end with both addons.

### Phase 3 — caddy-auth (v1)

- `caddy-auth-sidecar/`: Dockerfile, Caddyfile.tmpl, build scripts, CLAUDE.md.
- `server/src/services/stack-addons/caddy-auth/`: manifest + compose fragment + provision (reads OIDC config from Vault).
- Vault path convention: `secret/connected-services/oidc/<provider>` with `client_id`, `client_secret`, `issuer`, `redirect_uri`.
- Composition logic: when `caddy-auth` and `tailscale-web` are both present, rewrite the serve.json to forward to Caddy's port.
- Tests: Caddyfile rendering, three-way composition.

### Phase 4 — Pool integration

- `server/src/services/stacks/pool-spawn.ts`: extend the spawn flow to invoke addon provisioning per instance, create per-instance sidecar containers, set `network_mode: container:<sidecar-id>`.
- `pool-instance-reaper.ts`: extend to clean up addon containers when instances are reaped, call `cleanup()` hooks.
- Per-instance hostname builder (uses `instanceId`).
- Container labels: `mini-infra.addon: <kind>` on sidecar containers.
- Tests: pool spawn with addons, pool reaper teardown.

### Phase 5 — UI polish + status surfacing

- Connect panel improvements: per-pool-instance rows, live-updating online/offline badges via Socket.IO.
- "Test connection" button per service (Mini Infra calls Tailscale API to check device presence).
- Addon-status rollup on the stack detail header.

### Phase 6 (deferred) — OIDC provider management UI

- `OidcProvider` Prisma model.
- Admin UI to add/edit IdPs.
- Migration: `caddy-auth` provision module switches from Vault-direct lookup to `OidcProvider` resolution.

## Decisions made during ideation

| Question | Decision |
|---|---|
| One Tailscale sidecar per service or per stack? | Per service (including per pool instance). Per-service identity is necessary for ACL scoping and meaningful hostnames. |
| Hostname convention? | `{service}-{env}` for static services; `{service}-{env}-{instanceId}` for pool instances. Drops stack name to keep names readable. |
| `action: check` vs `action: accept` for SSH ACL default? | `check` with 12h checkPeriod. Right default for production-managing tools — one IdP re-auth per day per operator. |
| Merge `tailscale-ssh` + `tailscale-web` into one sidecar, or run two? | Merge. They share state, identity, and one tailnet device. Two sidecars would double tailnet device count for no operational benefit. Implemented via the `kind: tailscale` merge group. |
| Caddy vs oauth2-proxy / Authelia / Pomerium / Authentik? | Caddy. Operator has prior production experience using Caddy as an auth proxy; "worked really well" outweighs feature-matrix differences for v1. |
| `caddy-auth` v1 stores OIDC config where? | Vault, manually edited. UI for `OidcProvider` is deferred to v2. Lets us ship the addon without a new model + UI surface. |
| Tailscale Funnel in v1? | No. Public exposure overlaps the existing Cloudflare tunnel feature; defer until we have a clear "use Funnel for X" case. |
| Addon configs: list of objects or map? | Map (`addons.tailscale-ssh: {...}`). Each addon is unique per service; map prevents duplicates and reads better. |
| Addon directory layout: per-addon directories or shared? | Per-addon. Shared utilities (`tailscale/shared/`) live in a sibling directory, not co-mingled with manifest+template files. |
| Pool addon application timing? | Per instance at spawn, not at apply. Pool services don't have apply-time containers; addons must run when instances do. |
| Naming: `auth-proxy` or `caddy-auth`? | `caddy-auth`. Avoids collision with the existing outbound `auth-proxy-sidecar-plan.md`. |

## Open threads to confirm before Phase 1

1. **Connected Service config model.** Does extending `ConnectedService` with three Tailscale-specific columns belong on the shared model, or should we follow the per-type-table pattern other connected services use? Worth a 30-minute look at the existing `connected-services` directory before settling.
2. **ACL-bootstrap snippet rendering.** Is JSON the right format, or should we render in HuJSON (Tailscale's commenting variant)? HuJSON is friendlier for the operator's eventual editing but requires a dependency. Default to plain JSON unless there's a strong preference.
3. **Caddy image source.** Build our own at `caddy-auth-sidecar/`, or pull `caddy:latest` and mount config? Building our own pins the `caddy-security` plugin version and matches the `update-sidecar` / `agent-sidecar` pattern; pulling upstream reduces our maintenance load. Mild preference for building our own — same shape as the rest of the codebase.
4. **Tailscale node key persistence on Pool instances.** Per-instance state volumes are cheap (single file), but Pool instances are short-lived (minutes-to-hours). With `ephemeral: true`, the node auto-cleans on offline, and a fresh authkey-per-spawn means the volume is effectively write-only. Confirm: skip the state volume on Pool instances and let each spawn re-register? Slight tailnet API load, but cleaner state management.
5. **Pool instance hostname collisions across stacks.** `worker-prod-u12345` in stack A and stack B collide. Per-service tags (`tag:stack-<id>`) prevent ACL crossover, but the tailnet device list shows duplicates by name. Consider prefixing pool hostnames with the stack name, accepting longer names. Worth a small UX call before Phase 4.
