# Service Addons — Tailscale and Caddy ingress addons

**Status:** planned, not implemented. Phased rollout — each phase is a separate Linear issue.
**Builds on:** the existing `Pool` service type and stack-template plumbing ([`PoolConfig`](../../../lib/types/stacks.ts), [`pool-spawner.ts`](../../../server/src/services/stacks/pool-spawner.ts), [`pool-instance-reaper.ts`](../../../server/src/services/stacks/pool-instance-reaper.ts)), the connected-services pattern ([Docker / Azure / Cloudflare / GitHub](../../../server/src/services/connected-services/)), and Vault credential storage.
**Excludes:** outbound credential proxying — that work lives in the separate [auth-proxy-sidecar-plan.md](auth-proxy-sidecar-plan.md). The `caddy-auth` addon in this plan is an *inbound* user-auth gate and is intentionally named to avoid collision.

---

## 1. Background

Three feature requests for stack-deployed services share the same structural shape: attach a sidecar that handles a cross-cutting ingress concern. Operators want Tailscale SSH access without exposing port 22 or distributing keys; internal tools want a friendly `https://<name>.<tailnet>.ts.net` URL with auto-provisioned TLS; services that don't speak OIDC themselves want a reverse-proxy in front of them that does. Each is "wrap the service with a sidecar"; without a framework, three bespoke template fields and three bespoke code paths grow in parallel. The Service Addons framework lets a stack service opt into one or more named capabilities by adding entries to a single `addons:` block, and lets the team ship a fourth (log shipping, volume backup, Prometheus exporter) by dropping a directory into `server/src/services/stack-addons/`.

User-friendliness was a stated design pressure. The cost of "add an addon" must be one line of YAML on the service definition; the cost of "connect to the resulting service from a developer laptop" must be effectively zero-config — Tailscale handles identity, MagicDNS handles hostnames, and the Mini Infra UI surfaces the address.

## 2. Goals

1. **A declarative `addons:` block** on `StackServiceDefinition` accepting a map of addon-id → addon-config. `addons: { tailscale-ssh: {} }` is the minimum-viable form.
2. **Self-contained addon directories** under `server/src/services/stack-addons/<id>/` containing a manifest (with config schema, applicability, connected-service prerequisites), a compose-fragment template, and a small TypeScript module for apply-time provisioning. Adding an addon is dropping a directory.
3. **Pool-aware lifecycle.** Addons declared on a `Pool`-type service evaluate per pool instance at spawn time, so each pool worker gets its own sidecar identity and per-instance hostname.
4. **Tailscale becomes a Connected Service** alongside Docker / Azure / Cloudflare / GitHub, with credential storage in Vault, connectivity probing, and an admin UI that emits a copy-paste ACL bootstrap snippet.
5. **Three v1 addons.** `tailscale-ssh` (operator SSH via tailnet identity), `tailscale-web` (HTTPS exposure on the tailnet with auto-provisioned TLS), and `caddy-auth` (inbound OIDC gate via Caddy).
6. **Friendly end-user surfaces.** The stack detail page exposes a "Connect" panel listing every addon-attached endpoint with one-click `ssh`/HTTPS, including per-pool-instance entries when expanded.

## 3. Non-goals

- **Multi-tailnet support.** v1 binds Mini Infra to one tailnet via one OAuth client. Operators with multiple tailnets are out of scope.
- **Auto-managing the tailnet ACL.** v1 emits a copy-paste snippet the operator pastes into their tailnet policy file; we do not call the Tailscale ACL API.
- **Tailscale Funnel (public exposure).** v1 ships `tailscale-web` in tailnet-only mode. Funnel overlaps the existing Cloudflare tunnel feature; deferred.
- **Full OIDC provider management.** v1 ships the Caddy sidecar reading provider config from Vault directly. The `OidcProvider` model and admin UI for managing IdPs are deferred (see Phase 6).
- **User-defined addons.** Only addons in the registry are usable; addon authoring is not a user-facing feature.
- **Cross-stack addon composition.** Addons are scoped to one service in one stack. No "addon X depends on addon Y on a different stack."
- **Drift detection on tailnet devices.** Ephemeral nodes self-clean; a reconciler that detects "this Tailscale device exists but no longer corresponds to a running container" is deferred.

## 4. The addon framework

A new `addons` block on `StackServiceDefinition` carries a map of addon-id → addon-config. The runtime resolves entries through an addon registry, validates each config blob against the addon's manifest schema, runs apply-time provisioning, renders compose fragments, and merges them into the rendered stack before reconciliation.

### 4.1 Concepts

- **Service Addon.** A named capability that wraps a service with one or more sidecars and contributes provisioning steps. Identified by a stable string (`tailscale-ssh`).
- **Addon manifest.** Declares the addon's identity, description, configuration schema, applicability (which `serviceType`s it supports), connected-service prerequisites, and merge strategy.
- **Addon kind.** An optional grouping label. When two addons of the same kind are declared on the same service, the runtime merges them into a single sidecar rather than spawning two. `tailscale-ssh` and `tailscale-web` share `kind: tailscale`.
- **Compose fragment.** A Mustache-templated docker-compose snippet rendered per service-addon application.
- **Provision hook.** Async function called before compose rendering. Receives the service definition and addon config; returns a `ProvisionedValues` map (sidecar env, target-service env, generated files, template variables) merged into the template context. This is where Tailscale authkeys are minted, Caddyfiles rendered, and per-instance secrets generated.
- **Service-addon application.** The runtime pairing of (one service, one addon, one config blob). Computed once at apply for static services; once per instance at spawn for pool services.

### 4.2 Addon contract

The contract that addon authors implement and the runtime consumes:

```ts
export interface AddonManifest {
  id: string;                                          // "tailscale-ssh"
  kind?: string;                                       // "tailscale" — sidecars merge per kind
  description: string;
  configSchema: z.ZodTypeAny;
  appliesTo: StackServiceType[];                       // ["Stateful", "StatelessWeb", "Pool"]
  requiresConnectedService?: ConnectedServiceType;
  sidecarMergeStrategy?: "shared-tailscale" | "standalone";
}

export interface ProvisionContext {
  stack: { id: string; name: string };
  service: { name: string; type: StackServiceType };
  environment: { id: string; name: string; networkType: "Local" | "Internet" };
  addonConfig: unknown;                                // already validated
  instance?: { instanceId: string };                   // present iff Pool spawn
  vault: VaultClient;
  connectedServices: ConnectedServiceLookup;
}

export interface ProvisionedValues {
  envForSidecar?: Record<string, string>;
  envForTargetService?: Record<string, string>;
  files?: Array<{ path: string; contents: string; mode?: number }>;
  templateVars: Record<string, unknown>;               // available as {{provisioned.*}} in compose fragment
}

export interface AddonModule {
  manifest: AddonManifest;
  provision(ctx: ProvisionContext): Promise<ProvisionedValues>;
  status?(ctx: StatusContext): Promise<AddonStatus>;
  cleanup?(ctx: ProvisionContext): Promise<void>;
}
```

### 4.3 Pipeline

For each `(service, addon)` pair:

1. **Validate.** Manifest's `configSchema` parses the user-supplied addon config. Failures surface in stack validation alongside other definition errors.
2. **Check applicability.** Reject if `serviceType` not in `appliesTo` or `requiresConnectedService` not configured.
3. **Resolve merge groups.** Group by `kind`. Manifest-defined merge functions combine configs (for `tailscale`: `{ ssh: bool, serve: ServeConfig | null }`).
4. **Provision.** Call each addon's (or merged group's) `provision()`.
5. **Render compose fragment.** Mustache-render with `{ service, stack, env, addon, provisioned, instance? }`.
6. **Merge.** Sidecar appended to `services:`; target service's `network_mode` rewritten to `service:<sidecar>`; original `ports:` claims removed (sidecar owns ingress); `envForTargetService` merged into target env.
7. **Apply.** Reconciler proceeds with the augmented compose.

For pool services the same pipeline runs at instance spawn rather than at apply, with `instance.instanceId` populated. Each instance gets its own sidecar container, its own provisioned credentials, and the per-instance hostname described below. Addon containers carry the same `mini-infra.stack-id` / `mini-infra.service` labels as the pool instance plus `mini-infra.addon: <kind>`. The pool reaper invokes `cleanup()` hooks when an instance is reaped.

### 4.4 Hostname convention

| Service shape | Hostname (TS_HOSTNAME / sidecar identity) |
|---|---|
| Static (`Stateful`, `StatelessWeb`) | `{service-name}-{env-name}` |
| Pool instance | `{service-name}-{env-name}-{instance-id}` |
| Pool instance, instanceId longer than fits | `{service-name}-{env-name}-{instance-id-sha256[:8]}` |

Sanitised to `[a-z0-9-]`, lowercased, max 63 chars (DNS label limit). For Tailscale-attached services this becomes the device name in the tailnet admin console, the MagicDNS short name, and the FQDN root for HTTPS exposure.

### 4.5 Permissions and events

Addons read from the same RBAC surface as their target features — `stacks:write` to add or remove an addon, `connected-services:write` to configure prerequisites. No new top-level permission domain. Two new addon-lifecycle Socket.IO events on the `stacks` channel surface provisioning progress and failures; a separate `tailscale` channel exposes device online/offline transitions polled from the Tailscale API.

## 5. The three v1 addons

### 5.1 `tailscale-ssh`

- **Kind:** `tailscale`. Merges with `tailscale-web` when both are present on the same service.
- **Requires:** Tailscale connected service.
- **Config:** optional `extraTags` (array of `tag:*` strings).
- **Provision:** mint a one-time, ephemeral, preauthorized authkey scoped to `tag:mini-infra-managed,tag:stack-<id>,tag:env-<env>,tag:service-<name>` plus `extraTags`. Inject `TS_AUTHKEY` and `TS_HOSTNAME` into the sidecar; pass `--ssh` in `TS_EXTRA_ARGS`.
- **End-user surface:** `ssh root@<service>-<env>` from any tailnet-joined laptop. Authentication is the tailnet identity provider via the ACL `ssh` stanza configured during connected-service setup. Default ACL is `action: check` with a 12-hour `checkPeriod` — one IdP re-auth per workday.

### 5.2 `tailscale-web`

- **Kind:** `tailscale`.
- **Requires:** Tailscale connected service.
- **Config:** required `port` (local container port to expose); optional `path` (URL prefix, defaults to `/`).
- **Provision:** mint authkey (same shape as `tailscale-ssh`); resolve the tailnet domain from the connected service; render a `serve.json` that terminates HTTPS on `${TS_CERT_DOMAIN}:443` and proxies to `127.0.0.1:<port>`; mount it at `TS_SERVE_CONFIG`.
- **End-user surface:** `https://<service>-<env>.<tailnet>.ts.net` opens directly with auto-provisioned Let's Encrypt certs. No tunnel, no DNS configuration, no port-forwarding.
- **Merge with `tailscale-ssh`:** the runtime emits one sidecar with both `--ssh` and `TS_SERVE_CONFIG` set, sharing one authkey, one hostname, one tailnet device, one state volume.

### 5.3 `caddy-auth`

- **Kind:** none — runs as a standalone sidecar in the same netns as the target service (and as `tailscale-web`'s sidecar when present).
- **Requires:** OIDC provider config in Vault at `secret/connected-services/oidc/<provider>` (v1); the deferred `OidcProvider` model in v2.
- **Config:** required `provider` (symbolic IdP id) and `upstreamPort`; optional `allowedGroups[]` and `publicPaths[]` (paths that bypass the auth gate).
- **Provision:** read OIDC client config from Vault; render a Caddyfile pinning `caddy-security` to the provider, gating the route on `allowedGroups`, exempting `publicPaths`, and reverse-proxying authenticated traffic to `127.0.0.1:<upstreamPort>`.
- **Composition with Tailscale.** When `tailscale-web` is also present, the runtime rewrites `serve.json` to proxy to Caddy's port instead of the app's, producing the chain `tailscale-web → caddy-auth → app` inside one shared netns.
- **Image source.** A new `caddy-auth-sidecar/` directory mirroring `update-sidecar/` and `agent-sidecar/`, building `mini-infra/caddy-auth:<tag>` with the `caddy-security` plugin pinned.

## 6. Phased rollout

Phases land in order — each phase blocks all subsequent phases. Phases 1-3 build the framework and the three addons against static services; Phase 4 generalises to pools; Phase 5 polishes the operator and end-user surfaces; Phase 6 is deferred follow-up work for OIDC management.

### Phase 1 — Addon framework + Tailscale connected service + `tailscale-ssh`

**Goal:** the framework exists end-to-end, and the simplest addon ships against static services.

Deliverables:
- The addon registry, manifest schema, runtime pipeline, and Mustache rendering helper as the foundation in `server/src/services/stack-addons/`.
- An `addons` field on `stackServiceDefinitionSchema` with per-addon `superRefine` validation against the registered manifests.
- The compose-builder gains a `mergeAddons` step that splices addon contributions into the rendered stack.
- A new `tailscale` connected-service type with OAuth client_id/secret in Vault, tailnet domain auto-discovery, default tags, and a click-to-copy ACL bootstrap snippet on the settings page.
- Tailscale connectivity prober wired into the existing `ConnectedServiceProber` and surfaced on the connected-services page.
- Authkey minter using OAuth `client_credentials` against the Tailscale API; access tokens cached with pre-expiry refresh.
- The `tailscale-ssh` addon directory with manifest, compose fragment, and provision module.
- Two new Socket.IO events on the `stacks` channel: `STACK_ADDON_PROVISIONED` and `STACK_ADDON_FAILED`.
- Admin documentation page walking through OAuth client creation, scopes, tagging, and pasting the ACL snippet.

Done when: a stack template with `addons: { tailscale-ssh: {} }` on a `Stateful` or `StatelessWeb` service applies cleanly, the Tailscale sidecar joins the tailnet under `tag:mini-infra-managed`, and an operator can `ssh root@<service>-<env>` from a tailnet-joined laptop with the IdP-driven `check` flow.

### Phase 2 — `tailscale-web` and tailscale addon merging

**Goal:** services expose HTTPS on the tailnet with auto-provisioned TLS; both Tailscale addons can run together as one sidecar.

Deliverables:
- The `tailscale-web` addon directory with manifest, compose fragment, and provision module that renders `serve.json` from the addon's port/path config.
- Merge logic in the addon runtime for shared-`kind` addons: when `tailscale-ssh` and `tailscale-web` both target the same service, one sidecar carries both `--ssh` and `TS_SERVE_CONFIG`, sharing one authkey and one state volume.
- The "Connect" panel on the stack detail page lists every addon-attached endpoint with one-click `ssh root@…` and `https://…` actions.
- A Tailscale device-status poller that emits `TAILSCALE_DEVICE_ONLINE` / `OFFLINE` on a new `tailscale` Socket.IO channel; the Connect panel reflects live status badges.

Done when: a service with both Tailscale addons enabled is reachable as `ssh root@<host>` and `https://<host>.<tailnet>.ts.net` from any tailnet-joined laptop, exactly one Tailscale device exists in the tailnet for that service, and the Connect panel shows the right URLs and live online/offline state.

### Phase 3 — `caddy-auth` v1

**Goal:** services can be gated on OIDC sign-in via a Caddy reverse proxy, composing with Tailscale when present.

Deliverables:
- A new standalone package `caddy-auth-sidecar/` mirroring the `update-sidecar` / `agent-sidecar` shape, building a `mini-infra/caddy-auth` image with the `caddy-security` plugin pinned.
- The `caddy-auth` addon directory with manifest, compose fragment, Caddyfile template, and provision module that resolves OIDC client config from Vault.
- Vault path convention `secret/connected-services/oidc/<provider>` documented for v1 manual editing.
- Composition logic: when `caddy-auth` and `tailscale-web` both target the same service, the runtime rewrites the Tailscale `serve.json` to forward to Caddy's port instead of the app's.
- Operator documentation page covering the Vault path layout and a worked example for one IdP (Entra ID).

Done when: a service with `caddy-auth` plus `tailscale-web` enabled redirects unauthenticated browsers to the IdP, accepts authenticated users whose group membership matches `allowedGroups`, returns 403 for users who don't match, and forwards authenticated traffic transparently to the app.

### Phase 4 — Pool integration

**Goal:** addons declared on a `Pool` service materialise per instance at spawn time.

Deliverables:
- The pool spawner invokes the addon pipeline with `instance: { instanceId }` populated, producing per-instance provisioned credentials and template variables.
- Per-instance sidecar containers created during pool spawn with the per-instance hostname convention; the pool instance container's `network_mode` set to the sidecar.
- The pool reaper extension cleans up addon containers when instances are reaped and invokes addon `cleanup()` hooks.
- Container labelling: addon sidecars carry the same `mini-infra.stack-id` / `mini-infra.service` / `mini-infra.pool-instance-id` labels as the pool instance, plus `mini-infra.addon: <kind>`.
- Connect panel pool-row expansion: clicking a pool service row reveals running instances with per-instance `ssh`/HTTPS rows.

Done when: a pool service with `addons: { tailscale-ssh: {} }` spawns instances that each register as their own tailnet device with a unique per-instance hostname, an operator can SSH into a specific instance by name, and idle reaping removes both the worker container and the sidecar from Docker (and the device from the tailnet via ephemeral cleanup).

### Phase 5 — UI polish and status surfacing

**Goal:** operators have a low-friction view of addon health and addressable endpoints.

Deliverables:
- Connect-panel improvements: per-pool-instance rows update live via the `tailscale` channel; copy-to-clipboard for `ssh` commands and URLs.
- An addon-status rollup on the stack detail header summarising addon health (provisioned / failed / pending) at a glance.
- A "Test connection" button per Tailscale-attached service that calls the Tailscale API to confirm the device is online and reports response time.
- Filter chip on the containers page using the `mini-infra.addon` label so operators can isolate addon sidecars.

Done when: the stack detail page surfaces the right URL for every addon-attached service (including pool instances), live online/offline transitions reflect within ~5s, and an operator can audit addon health for an entire stack from one screen.

### Phase 6 — OIDC provider management UI (optional, deferred)

**Goal:** managing IdPs becomes a first-class connected-service concern instead of direct Vault editing.

Deliverables:
- A new `OidcProvider` model with admin UI for adding, editing, and testing IdPs.
- The `caddy-auth` addon's provision module switches from direct Vault path lookup to `OidcProvider` resolution.
- A "test sign-in" affordance per provider that exercises the OAuth flow end-to-end and reports success or failure.

Done when: an admin can add a new IdP through the UI, attach it to a service via `addons: { caddy-auth: { provider: <id> } }`, and verify the round trip from the connected-services page without editing Vault directly.

## 7. Risks & open questions

- **Connected Service config model.** Three Tailscale-specific columns on `ConnectedService` may be the wrong shape if other connected services need similar growth. Worth a 30-minute look at the existing connected-services directory before Phase 1 to decide between a shared-table extension and a per-type satellite table.
- **ACL bootstrap rendering.** JSON is parseable; HuJSON (Tailscale's commenting variant) is friendlier for the operator's eventual hand-editing but introduces a dependency. Default to JSON unless a user objects.
- **Caddy image provenance.** Building our own `caddy-auth-sidecar` pins the `caddy-security` plugin version and matches the existing sidecar pattern; pulling upstream `caddy:latest` is one less moving part. Mild preference for building, but worth confirming during Phase 3.
- **Pool instance Tailscale state volume.** Per-instance state volumes are cheap, but pool instances are short-lived and authkeys are minted per-spawn. With ephemeral nodes auto-cleaning, the volume is effectively write-only. Phase 4 should validate that skipping the volume on pool instances doesn't introduce a re-registration race, and pick the cleaner of the two paths.
- **Pool instance hostname collisions across stacks.** `worker-prod-u12345` in stack A and `worker-prod-u12345` in stack B produce duplicate device names in the tailnet. Per-stack tags prevent ACL crossover but the device list stays ambiguous. Phase 4 may need to prefix pool hostnames with the stack name and accept longer hostnames.
- **Funnel-shaped follow-up.** Once Tailscale-only HTTPS is shipped, the smallest extension to reach the public internet is enabling Tailscale Funnel. It overlaps the Cloudflare tunnel feature, so a deliberate "when do you pick which?" call is needed before any Phase 6+ extension touches Funnel.
- **Addon config drift.** A definition-hash that includes the addon config block makes any addon edit a re-apply. Confirm during Phase 1 that the existing definition-hash logic naturally extends to the new field rather than oscillating on per-apply provisioned values.

## 8. Linear tracking

Phase issues will be created under a new "Service Addons — Tailscale and Caddy ingress" project on the Altitude Devops team and linked here once filed. Phases land in order; each phase blocks the next.

- ALT-_TBD_ — Phase 1: Addon framework + Tailscale connected service + `tailscale-ssh`
- ALT-_TBD_ — Phase 2: `tailscale-web` and tailscale addon merging
- ALT-_TBD_ — Phase 3: `caddy-auth` v1
- ALT-_TBD_ — Phase 4: Pool integration
- ALT-_TBD_ — Phase 5: UI polish and status surfacing
- ALT-_TBD_ — Phase 6 (deferred): OIDC provider management UI
