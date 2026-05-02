# Service Addons — Tailscale and Caddy ingress addons

**Status:** planned, not implemented. Phased rollout — each phase is a separate Linear issue.
**Builds on:** the existing `Pool` service type and stack-template plumbing ([`PoolConfig`](../../../lib/types/stacks.ts), [`pool-spawner.ts`](../../../server/src/services/stacks/pool-spawner.ts), [`pool-instance-reaper.ts`](../../../server/src/services/stacks/pool-instance-reaper.ts)), the connected-services pattern ([Docker / Azure / Cloudflare / GitHub](../../../server/src/services/connected-services/)), the `StackServiceDefinition` schema ([`lib/types/stacks.ts`](../../../lib/types/stacks.ts)), and Vault credential storage.
**Excludes:** outbound credential proxying — that work lives in the separate [auth-proxy-sidecar-plan.md](auth-proxy-sidecar-plan.md). The `caddy-auth` addon in this plan is an *inbound* user-auth gate and is intentionally named to avoid collision.

---

## 1. Background

Three feature requests for stack-deployed services share the same structural shape: attach a sidecar that handles a cross-cutting ingress concern. Operators want Tailscale SSH access without exposing port 22 or distributing keys; internal tools want a friendly `https://<name>.<tailnet>.ts.net` URL with auto-provisioned TLS; services that don't speak OIDC themselves want a reverse-proxy in front of them that does. Each is "wrap the service with a sidecar"; without a framework, three bespoke template fields and three bespoke code paths grow in parallel. The Service Addons framework lets a stack service opt into one or more named capabilities by adding entries to a single `addons:` block, and lets the team ship a fourth (log shipping, volume backup, Prometheus exporter) by dropping a directory into `server/src/services/stack-addons/`.

User-friendliness was a stated design pressure. The cost of "add an addon" must be one line of YAML on the service definition; the cost of "connect to the resulting service from a developer laptop" must be effectively zero-config — Tailscale handles identity, MagicDNS handles hostnames, and the Mini Infra UI surfaces the address.

A second design pressure: addon containers are still containers. They need logs, exec, drift detection, restart policies, healthchecks, labels, deployment events, RBAC, and every other piece of plumbing we already provide for stack services. Re-implementing that surface for "addon containers" would duplicate a large slice of `server/src/services/stacks/`. Instead, addons declare their sidecars *as* `StackServiceDefinition`s and ride the existing reconciler.

## 2. Goals

1. **A declarative `addons:` block** on `StackServiceDefinition` accepting a map of addon-id → addon-config. `addons: { tailscale-ssh: {} }` is the minimum-viable form. The user's authored stack carries only this terse block — the addon-derived sidecars never appear in the user's stack definition on disk or in the DB.
2. **`AddonDefinition` wraps a `StackServiceDefinition`.** Each addon directory under `server/src/services/stack-addons/<id>/` exports a definition whose sidecar is described as a full `StackServiceDefinition`, so addon containers inherit logs / exec / drift detection / labels / events / RBAC for free. Adding an addon is dropping a directory.
3. **Pool-aware lifecycle.** Addons declared on a `Pool`-type service materialise per pool instance at spawn time, so each pool worker gets its own sidecar identity and per-instance hostname.
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

### 4.1 Authored vs rendered stack definition

The framework's central trick: the user's authored stack is never modified by addons. Addons take effect during a *render* pass that runs before the reconciler.

- **Authored stack definition** — what the user wrote and what's persisted in the DB. Each `StackServiceDefinition` may carry an `addons:` block; that block is the only addon-related data on disk.
- **Rendered stack definition** — produced at apply (or at pool-instance spawn) by expanding the authored definition. The renderer materialises each addon's `serviceDefinition` template, splices the sidecars into the services list, and applies any target-side rewrites declared by the addon's `targetIntegration`. The reconciler consumes the rendered form and otherwise runs unchanged.

Because the rendered form is itself a `StackDefinition`, addon sidecars *are* `StackServiceDefinition`s by the time anything downstream sees them. Container labels, log streams, drift detection, restart policy, deployment events, the containers page, RBAC — all of it works without parallel implementation. This mirrors how a `Pool` service materialises into N per-instance containers at spawn time: the authored entity is one, the runtime entities are many, and the runtime entities flow through the same plumbing as everything else.

### 4.2 Concepts

- **Service Addon.** A named capability that wraps a target service with a sidecar (and possibly target-side modifications). Identified by a stable string (`tailscale-ssh`).
- **`AddonDefinition`.** What an addon directory exports. Combines the manifest, the templated `StackServiceDefinition` for the sidecar, the `targetIntegration` describing how the sidecar binds to its target, and the `provision()` hook that mints credentials and computes per-application values.
- **Addon manifest.** Declares the addon's identity, description, configuration schema, applicability (which `serviceType`s it supports), and connected-service prerequisites.
- **Addon kind.** An optional grouping label. When two addons of the same kind are declared on the same service, the runtime merges them into a single sidecar rather than spawning two. `tailscale-ssh` and `tailscale-web` share `kind: tailscale`. Merging is implemented by an `AddonMergeStrategy` registered for the kind.
- **Target integration.** A small enum + bag of values declaring how the sidecar attaches to its target service: peer-on-network, join-target-netns, or own-target-netns; plus optional env / mounts / port-reclaim flags. Most addons don't modify their target.
- **Provision hook.** Async function called before service-definition materialisation. Receives the addon config and full provision context; returns `ProvisionedValues` (env for sidecar, env for target, generated files, template variables) consumed by the materialisation step. This is where Tailscale authkeys are minted, Caddyfiles rendered, and per-instance secrets generated.
- **Service-addon application.** The runtime pairing of (one service, one addon, one config blob). Computed once at apply for static services; once per instance at spawn for pool services.

### 4.3 Addon contract

The contract addon authors implement and the runtime consumes:

```ts
export interface AddonManifest {
  id: string;                                          // "tailscale-ssh"
  kind?: string;                                       // "tailscale" — sidecars merge per kind
  description: string;
  configSchema: z.ZodTypeAny;
  appliesTo: StackServiceType[];                       // ["Stateful", "StatelessWeb", "Pool"]
  requiresConnectedService?: ConnectedServiceType;
}

export type TargetIntegration = {
  /**
   * - "peer-on-target-network": sidecar joins the same Docker network as the target;
   *   reaches the target by service name. Target unchanged. Default for non-intercepting addons.
   * - "join-target-netns": sidecar uses `network_mode: service:<target>`. Target unchanged
   *   in shape; sidecar reaches target on 127.0.0.1. For outbound interceptors and observers.
   * - "own-target-netns": target's `network_mode` rewritten to `service:<sidecar>`; target's
   *   published ports stripped (when reclaimTargetPorts is set) and inherited by the sidecar.
   *   For unbypassable ingress gates.
   */
  network: "peer-on-target-network" | "join-target-netns" | "own-target-netns";
  envForTarget?: Record<string, string>;
  mountsForTarget?: StackServiceMount[];
  reclaimTargetPorts?: boolean;                        // valid only with "own-target-netns"
};

export interface ProvisionContext {
  stack: { id: string; name: string };
  service: { name: string; type: StackServiceType };
  environment: { id: string; name: string; networkType: "Local" | "Internet" };
  addonConfig: unknown;                                // already validated against configSchema
  instance?: { instanceId: string };                   // present iff Pool spawn
  vault: VaultClient;
  connectedServices: ConnectedServiceLookup;
}

export interface ProvisionedValues {
  envForSidecar?: Record<string, string>;
  envForTarget?: Record<string, string>;               // merged into TargetIntegration.envForTarget
  files?: Array<{ path: string; contents: string; mode?: number }>;
  templateVars: Record<string, unknown>;               // available to buildServiceDefinition
}

export interface AddonDefinition {
  manifest: AddonManifest;
  targetIntegration: TargetIntegration;
  provision(ctx: ProvisionContext): Promise<ProvisionedValues>;
  buildServiceDefinition(
    ctx: ProvisionContext,
    provisioned: ProvisionedValues,
  ): StackServiceDefinition;                           // the sidecar, fully formed
  cleanup?(ctx: ProvisionContext, provisioned: ProvisionedValues): Promise<void>;
  status?(ctx: StatusContext): Promise<AddonStatus>;
}

export interface AddonMergeStrategy {
  kind: string;
  targetIntegration: TargetIntegration;                // single integration for the merged group
  provision(
    ctx: ProvisionContext,
    members: Array<{ addonId: string; config: unknown }>,
  ): Promise<ProvisionedValues>;
  buildServiceDefinition(
    ctx: ProvisionContext,
    provisioned: ProvisionedValues,
    members: Array<{ addonId: string; config: unknown }>,
  ): StackServiceDefinition;
}
```

`buildServiceDefinition` returns a `StackServiceDefinition` rather than a compose YAML fragment. Provision values flow in through `ProvisionedValues.envForSidecar` and `templateVars`; the function chooses how to use them — usually by interpolating into env values, command args, mount sources, or labels on the returned definition. Choosing function-form over a Mustache-templated YAML keeps the sidecar's shape exactly the type the rest of the codebase already understands, avoids string-template type-safety holes, and lets the addon author use the same helpers (volume name builders, label helpers, healthcheck builders) the rest of the stacks code uses.

### 4.4 Render pipeline

For each `(service, addon)` pair on the authored stack:

1. **Validate.** Manifest's `configSchema` parses the user-supplied addon config. Failures surface in stack validation alongside other definition errors.
2. **Check applicability.** Reject if `serviceType` not in `appliesTo` or if `requiresConnectedService` is not configured.
3. **Resolve merge groups.** Group by `kind`. For each group with more than one member, look up the registered `AddonMergeStrategy` for the kind; for solo members the addon's own `provision` / `buildServiceDefinition` run directly.
4. **Provision.** Call `provision()` (or the merge strategy's `provision()` for a group). Side effects (authkey minting, Vault writes, tailnet device pre-registration) happen here.
5. **Materialise sidecar.** Call `buildServiceDefinition()` to produce the addon's `StackServiceDefinition`. Append it to the rendered stack's services list with a `synthetic: true` flag and back-reference to its target service.
6. **Apply target integration.** Walk the `targetIntegration` for the application:
   - `peer-on-target-network`: ensure the sidecar service definition declares the target's network; no rewrite to the target.
   - `join-target-netns`: set the sidecar's `network_mode` to `service:<target>`. Inject `envForTarget` and `mountsForTarget` (from both the integration spec and provisioned values) into the target service definition.
   - `own-target-netns`: set the target's `network_mode` to `service:<sidecar>`. If `reclaimTargetPorts`, move the target's `ports:` claims onto the sidecar and bind the target to localhost. Inject env / mounts as above.
7. **Run cross-addon rewrites.** A small post-merge step lets specific addon combinations rewire each other — concretely, when `caddy-auth` and `tailscale-web` both apply to the same target, the runtime rewrites Tailscale's `serve.json` to forward to Caddy's port instead of the app's. This is the only target-aware composition that escapes the one-addon-at-a-time loop above.
8. **Reconcile.** The rendered stack definition flows into the existing reconciler unchanged.

For pool services the same pipeline runs at instance spawn rather than at apply, with `instance.instanceId` populated. Each instance gets its own sidecar `StackServiceDefinition`, its own provisioned credentials, and the per-instance hostname described below. Addon sidecars carry the same `mini-infra.stack-id` / `mini-infra.service` labels as the pool instance plus `mini-infra.addon: <kind-or-id>` and `mini-infra.synthetic: true`. The pool reaper invokes `cleanup()` hooks when an instance is reaped.

### 4.5 Hostname convention

| Service shape | Hostname (TS_HOSTNAME / sidecar identity) |
|---|---|
| Static (`Stateful`, `StatelessWeb`) | `{service-name}-{env-name}` |
| Pool instance | `{service-name}-{env-name}-{instance-id}` |
| Pool instance, instanceId longer than fits | `{service-name}-{env-name}-{instance-id-sha256[:8]}` |

Sanitised to `[a-z0-9-]`, lowercased, max 63 chars (DNS label limit). For Tailscale-attached services this becomes the device name in the tailnet admin console, the MagicDNS short name, and the FQDN root for HTTPS exposure.

### 4.6 Permissions and events

Addons read from the same RBAC surface as their target features — `stacks:write` to add or remove an addon, `connected-services:write` to configure prerequisites. No new top-level permission domain. Two new addon-lifecycle Socket.IO events on the `stacks` channel surface provisioning progress and failures; a separate `tailscale` channel exposes device online/offline transitions polled from the Tailscale API.

### 4.7 Interaction with the egress firewall

The egress firewall ([egress-gateway/CLAUDE.md](../../../egress-gateway/CLAUDE.md), [egress-fw-agent/CLAUDE.md](../../../egress-fw-agent/CLAUDE.md)) and the addon framework compose without any new primitive, because the firewall enforces at the network/host layer (env-scoped Docker bridge + nftables + L7 forward proxy at the bridge `.2`) and addon sidecars are real `StackServiceDefinition`s that join the same network as their target. Three properties make this fall out for free:

1. **Network membership is the only thing that matters for enforcement.** When the env's `egressFirewallEnabled` flag is on, every container on the env's egress network has its outbound L3/L4 dropped by the host fw-agent except via the gateway, and the gateway applies the L7 hostname allowlist. Addon sidecars join the target service's network during render — for firewalled envs that *is* the egress network — so they're automatically in scope. No per-addon firewall plumbing is needed for any of the three `targetIntegration` modes.
2. **`requiredEgress` declarations flow through `containerConfig` automatically.** The egress-policy reconciler ([egress-policy-lifecycle.ts](../../../server/src/services/egress/egress-policy-lifecycle.ts)) reads `requiredEgress: string[]` off each service's `containerConfig` and seeds template-sourced rules. Because `AddonDefinition.buildServiceDefinition()` returns a full `StackServiceDefinition` whose `containerConfig` is just a `StackContainerConfig`, the addon declares its sidecar's required outbound destinations there — Tailscale's coordination plane (`*.tailscale.com`, `controlplane.tailscale.com`, DERP relays), Caddy's IdP endpoints (discovery / token / JWKS), the outbound auth proxy's upstream host list — and the existing reconciler picks them up alongside user-authored services' patterns. No new framework primitive, no parallel firewall code path.
3. **Fixed vs config-derived `requiredEgress`.** Tailscale and Caddy have fixed control-plane dependencies — encode them as constants the addon's `buildServiceDefinition()` writes into `containerConfig.requiredEgress`. The outbound auth proxy is config-derived: `provision()` computes the upstream host list from the addon config and threads it through `templateVars` so `buildServiceDefinition()` can emit the right `requiredEgress`.

#### Worked example: agent that needs both the firewall and extra auth headers

A target agent service in a firewalled env, with the (separate-plan) outbound auth proxy attached:

```
agent container (target)
  └─ HTTP_PROXY=http://127.0.0.1:8080  ← injected by auth-proxy addon via envForTarget
       │
       ▼
   auth-proxy-sidecar      (join-target-netns: shares agent's netns; on env egress network)
       │ adds Authorization / API-Key headers from Vault
       ▼
   env egress network bridge gateway (.1)
       │ nftables on host: only the gateway container's IP may egress this subnet
       ▼
   egress-gateway container (.2)
       │ Smokescreen L7 allowlist on Host header
       ▼
   external destination
```

Behaviours worth pinning:

- **The agent doesn't know the firewall exists.** It talks to `HTTP_PROXY` on localhost; the chain after that is invisible to its code.
- **The L7 gateway sees the proxy's outbound, not the agent's.** Since the auth proxy preserves the `Host:` header (it's adding auth, not rewriting destination), the hostname allowlist behaves identically to a no-proxy setup. If a future auth-proxy ever rewrites destinations, its `requiredEgress` must list the *actual* upstream hostnames, not the apparent ones — flagged in the auth-proxy plan, not here.
- **No double-proxy loop.** The auth proxy doesn't know the egress gateway exists. Its outbound socket connects directly to the destination IP; bridge routing + nftables transparently force that flow through the gateway. Two separate proxies, neither configured against the other.
- **Each container's `requiredEgress` unions independently.** With `caddy-auth` + `own-target-netns` + `reclaimTargetPorts`, target and sidecar are still distinct service rows — their required-egress sets union at policy reconcile time. Same for the agent + auth-proxy case: agent declares its real upstreams, auth-proxy adds whatever it needs (e.g., a credential-fetch endpoint), policy picks up both.
- **Cross-addon ordering is irrelevant for egress.** Inbound chains like `tailscale-web → caddy-auth → app` only affect the inbound path. Each container's outbound is independently firewalled by being on the egress network; nothing about the inbound chain changes that.

#### Implications for Phase 1

The framework deliverables don't grow — `containerConfig.requiredEgress` already exists on `StackContainerConfig` and the reconciler already reads it. What's required instead is documentation and a sanity check: Phase 1's `tailscale-ssh` addon must encode the right Tailscale control-plane hostnames in its `buildServiceDefinition()` output, and Phase 1's done-when criteria should include "addon attached to a service in a firewalled env still functions, with the addon-declared hostnames showing up as template-sourced rules in the env's egress policy." Phase 3's `caddy-auth` adds the IdP-resolved hostnames; Phase 4 verifies pool-instance addon services emit per-instance `requiredEgress` correctly. Phases 2 and 5 don't touch this surface.

## 5. The three v1 addons

Each addon below describes its `targetIntegration` shape, the `StackServiceDefinition` its `buildServiceDefinition()` produces (in shorthand), and the inputs flowing in from `provision()`.

### 5.1 `tailscale-ssh`

- **Kind:** `tailscale`. Merges with `tailscale-web` when both are present on the same service.
- **Requires:** Tailscale connected service.
- **Config:** optional `extraTags` (array of `tag:*` strings).
- **Target integration:** `network: "peer-on-target-network"`. The sidecar joins the same Docker network as the target so it can reach `<target>:<port>` by name. The target service is unmodified — no `network_mode` rewrite, no port reclamation.
- **Provision:** mint a one-time, ephemeral, preauthorized authkey scoped to `tag:mini-infra-managed,tag:stack-<id>,tag:env-<env>,tag:service-<name>` plus `extraTags`. Returns `envForSidecar: { TS_AUTHKEY, TS_HOSTNAME }` and `templateVars: { tsExtraArgs: "--ssh" }`.
- **Sidecar `StackServiceDefinition`:** Tailscale image, the provisioned env, a per-application state volume, no published ports, the standard mini-infra labels, `restart: unless-stopped`, and `containerConfig.requiredEgress` listing the Tailscale control-plane hostnames (`controlplane.tailscale.com`, `*.tailscale.com`, `*.tailscale.io`, DERP relay hostnames) so the egress-policy reconciler pre-allows them in firewalled envs (§4.7).
- **End-user surface:** `ssh root@<service>-<env>` from any tailnet-joined laptop. Authentication is the tailnet identity provider via the ACL `ssh` stanza configured during connected-service setup. Default ACL is `action: check` with a 12-hour `checkPeriod` — one IdP re-auth per workday.

### 5.2 `tailscale-web`

- **Kind:** `tailscale`.
- **Requires:** Tailscale connected service.
- **Config:** required `port` (local container port to expose); optional `path` (URL prefix, defaults to `/`).
- **Target integration:** `network: "peer-on-target-network"`. Same as `tailscale-ssh` — the sidecar reaches the app by service-name DNS over the shared Docker network. No target rewrite.
- **Provision:** mint authkey (same shape as `tailscale-ssh`); resolve the tailnet domain from the connected service; render a `serve.json` that terminates HTTPS on `${TS_CERT_DOMAIN}:443` and proxies to the target service's `port`. Returns the file under `files: [{ path: "/etc/tailscale/serve.json", … }]` and the env (`TS_AUTHKEY`, `TS_HOSTNAME`, `TS_SERVE_CONFIG=/etc/tailscale/serve.json`).
- **Sidecar `StackServiceDefinition`:** as for `tailscale-ssh` (including the same `requiredEgress` for the Tailscale control plane), plus a config-file mount populated from the provisioned `files`.
- **End-user surface:** `https://<service>-<env>.<tailnet>.ts.net` opens directly with auto-provisioned Let's Encrypt certs. No tunnel, no DNS configuration, no port-forwarding.
- **Merge with `tailscale-ssh`:** the registered `kind: tailscale` merge strategy emits one sidecar definition with both `--ssh` and `TS_SERVE_CONFIG` set, sharing one authkey, one hostname, one tailnet device, one state volume, one published serve.json.

### 5.3 `caddy-auth`

- **Kind:** none — runs as a standalone sidecar.
- **Requires:** OIDC provider config in Vault at `secret/connected-services/oidc/<provider>` (v1); the deferred `OidcProvider` model in v2.
- **Config:** required `provider` (symbolic IdP id) and `upstreamPort`; optional `allowedGroups[]` and `publicPaths[]` (paths that bypass the auth gate).
- **Target integration:** `network: "own-target-netns"`, `reclaimTargetPorts: true`. Caddy is unbypassable only if it owns ingress, so the runtime rewrites the target's `network_mode` to `service:<caddy-sidecar>`, moves the target's published ports onto the sidecar, and binds the target to `127.0.0.1`. No env injection into the target.
- **Provision:** read OIDC client config from Vault; render a Caddyfile pinning `caddy-security` to the provider, gating the route on `allowedGroups`, exempting `publicPaths`, and reverse-proxying authenticated traffic to `127.0.0.1:<upstreamPort>`. Resolve the IdP's discovery / token / JWKS hostnames from the provider config and surface them via `templateVars` for `buildServiceDefinition` to use as `requiredEgress`. Returns the Caddyfile under `files`.
- **Sidecar `StackServiceDefinition`:** the `mini-infra/caddy-auth` image, no published ports of its own (the target's reclaimed ports flow in via `targetIntegration`), a config-file mount for the Caddyfile, `containerConfig.requiredEgress` populated with the IdP hostnames resolved during provision (§4.7), the standard mini-infra labels.
- **Composition with Tailscale.** When `tailscale-web` is also present on the same service, the cross-addon rewrite step (§4.4 step 7) rewrites Tailscale's `serve.json` to proxy to Caddy's port instead of the app's, producing the chain `tailscale-web → caddy-auth → app` in the rendered definition. The Tailscale sidecar still uses `peer-on-target-network`; the Caddy sidecar still uses `own-target-netns`. The two integrations don't conflict because Tailscale never asks for the target's netns.
- **Image source.** A new `caddy-auth-sidecar/` directory mirroring `update-sidecar/` and `agent-sidecar/`, building `mini-infra/caddy-auth:<tag>` with the `caddy-security` plugin pinned.

### 5.4 Forward look: outbound auth proxy

Out of scope for this plan, but worth confirming the framework fits the next addon-shaped feature without further extension. The agent auth proxy ([auth-proxy-sidecar-plan.md](auth-proxy-sidecar-plan.md)) intercepts *outbound* HTTP from a target so it can inject upstream credentials. It maps to `network: "join-target-netns"` plus `envForTarget: { HTTP_PROXY, HTTPS_PROXY, NODE_EXTRA_CA_CERTS }` plus `mountsForTarget` for a CA bundle. Its `requiredEgress` is config-derived — `provision()` reads the user's upstream-host list from the addon config and the resulting `containerConfig.requiredEgress` rides into the egress-policy reconcile alongside the agent's own declarations (§4.7). No new framework primitive is required.

## 6. Phased rollout

Phases land in order — each phase blocks all subsequent phases. Phases 1-3 build the framework and the three addons against static services; Phase 4 generalises to pools; Phase 5 polishes the operator and end-user surfaces; Phase 6 is deferred follow-up work for OIDC management.

### Phase 1 — Addon framework + Tailscale connected service + `tailscale-ssh`

**Goal:** the framework exists end-to-end, and the simplest addon ships against static services.

Deliverables:
- The addon registry and `AddonDefinition` / `AddonMergeStrategy` types in `server/src/services/stack-addons/`.
- The render pipeline: the existing stack-render step gains an addon-expansion phase that runs validation → applicability check → merge-group resolution → provision → `buildServiceDefinition` → target-integration application. The reconciler is unchanged; it consumes the rendered (expanded) stack definition.
- An `addons` field on `stackServiceDefinitionSchema` with per-addon `superRefine` validation against the registered manifests.
- Synthetic-service flagging: rendered addon services carry `synthetic: true` and a back-reference to the target service so the UI can label them as derived rather than user-authored.
- A new `tailscale` connected-service type with OAuth client_id/secret in Vault, tailnet domain auto-discovery, default tags, and a click-to-copy ACL bootstrap snippet on the settings page.
- Tailscale connectivity prober wired into the existing `ConnectedServiceProber` and surfaced on the connected-services page.
- Authkey minter using OAuth `client_credentials` against the Tailscale API; access tokens cached with pre-expiry refresh.
- The `tailscale-ssh` addon directory with manifest, `targetIntegration` (`peer-on-target-network`), `provision`, and `buildServiceDefinition`. The materialized sidecar's `containerConfig.requiredEgress` lists the Tailscale control-plane hostnames (§4.7) so attaching the addon in a firewalled env works without manual policy edits.
- Two new Socket.IO events on the `stacks` channel: `STACK_ADDON_PROVISIONED` and `STACK_ADDON_FAILED`.
- Admin documentation page walking through OAuth client creation, scopes, tagging, and pasting the ACL snippet.

Reversibility: feature-flagged — addon expansion runs only when a service declares `addons:`; with the registry empty no behaviour changes. Rollback is reverting the PR or removing the registered `tailscale-ssh` addon. Tailscale connected service is opt-in (admin must add it), so absence of credentials is also a clean no-op state.

UI changes:
- Connected Services page gains a "Tailscale" entry alongside Docker / Azure / Cloudflare / GitHub: connection status, last-checked timestamp, edit form. [no design] — fits the established connected-service card pattern.
- Settings: new "Tailscale" admin form for OAuth client_id/secret, default tags, and a click-to-copy ACL-bootstrap snippet box. [design needed] — the snippet preview + tag list + copy block layout is new for our settings forms.
- Stack detail / Containers page: addon-derived sidecars appear in the existing service/container lists with a "from addon" badge and a back-reference to the target service; edit affordances disabled. [design needed] — badge style and how a synthetic sidecar visually relates to its target row (indented? linked icon?) needs a designer call.
- Stack apply flow: live progress reflects two new lifecycle events (`STACK_ADDON_PROVISIONED`, `STACK_ADDON_FAILED`) under the existing apply task in the task tracker. [no design] — slots into existing task-tracker step rendering.
- New admin docs page walking operators through Tailscale OAuth client creation and ACL bootstrap. [no design] — uses the existing user-docs article shell.

Done when: a stack template with `addons: { tailscale-ssh: {} }` on a `Stateful` or `StatelessWeb` service applies cleanly, the Tailscale sidecar appears as a synthetic service in the rendered stack, joins the tailnet under `tag:mini-infra-managed`, shows up on the containers page with logs/exec/labels working, and an operator can `ssh root@<service>-<env>` from a tailnet-joined laptop with the IdP-driven `check` flow. *Firewall sanity check:* the same template applied in an env with `egressFirewallEnabled: true` still works end-to-end, and the Tailscale control-plane hostnames appear as template-sourced rules on the env's egress policy without operator intervention.

Verify in prod: Tailscale entry appears under Connected Services with a green status; the first stack applied with `addons: { tailscale-ssh: {} }` shows the sidecar online in the Tailscale admin console under `tag:mini-infra-managed`; no spike in `STACK_ADDON_FAILED` events for 24 h after rollout.

### Phase 2 — `tailscale-web` and tailscale addon merging

**Goal:** services expose HTTPS on the tailnet with auto-provisioned TLS; both Tailscale addons can run together as one sidecar.

Deliverables:
- The `tailscale-web` addon directory with manifest, `targetIntegration` (`peer-on-target-network`), `provision` (renders `serve.json` from port/path config), and `buildServiceDefinition`.
- `AddonMergeStrategy` registered for `kind: tailscale`: when `tailscale-ssh` and `tailscale-web` both target the same service, one sidecar definition carries both `--ssh` and `TS_SERVE_CONFIG`, sharing one authkey, one hostname, and one state volume.
- The "Connect" panel on the stack detail page lists every addon-attached endpoint with one-click `ssh root@…` and `https://…` actions.
- A Tailscale device-status poller that emits `TAILSCALE_DEVICE_ONLINE` / `OFFLINE` on a new `tailscale` Socket.IO channel; the Connect panel reflects live status badges.

Reversibility: feature-flagged — only services that opt into `tailscale-web` are affected; merging is automatic when both Tailscale addons are present. Rollback is removing the addon from the service definition (next apply unrolls the sidecar config). Tailnet device de-registration happens via ephemeral cleanup so there's no residual state to reap.

UI changes:
- Stack detail page: new "Connect" panel listing every addon-attached endpoint with one-click `ssh root@…` and `https://…` actions. [design needed] — brand-new panel; placement relative to the services list, empty / failed / loading states all need design.
- Live status badges on Connect panel rows reflecting `TAILSCALE_DEVICE_ONLINE` / `OFFLINE` events. [design needed] — needs a green / grey / red dot style and the transition timing pattern.
- New Socket.IO channel `tailscale` surfaced via the existing connection-status indicator (same place users see other channel disconnections). [no design].

Done when: a service with both Tailscale addons enabled is reachable as `ssh root@<host>` and `https://<host>.<tailnet>.ts.net` from any tailnet-joined laptop, exactly one Tailscale device exists in the tailnet for that service, and the Connect panel shows the right URLs and live online/offline state.

Verify in prod: at least one production service is reachable via both `ssh root@<host>` and `https://<host>.<tailnet>.ts.net`; tailnet device count matches the count of `tailscale-*` addon applications recorded in the DB; Connect panel renders within ~1 s and badges flip within ~5 s of a real device transition.

### Phase 3 — `caddy-auth` v1

**Goal:** services can be gated on OIDC sign-in via a Caddy reverse proxy, composing with Tailscale when present.

Deliverables:
- A new standalone package `caddy-auth-sidecar/` mirroring the `update-sidecar` / `agent-sidecar` shape, building a `mini-infra/caddy-auth` image with the `caddy-security` plugin pinned.
- The `caddy-auth` addon directory with manifest, `targetIntegration` (`own-target-netns` + `reclaimTargetPorts: true`), `provision` (reads OIDC config from Vault, renders Caddyfile, resolves the IdP's discovery / token / JWKS hostnames), and `buildServiceDefinition` (writes the resolved IdP hostnames into `containerConfig.requiredEgress` per §4.7 so the addon works in firewalled envs without manual policy edits).
- Vault path convention `secret/connected-services/oidc/<provider>` documented for v1 manual editing.
- Cross-addon rewrite: when `caddy-auth` and `tailscale-web` both apply, the post-merge step rewrites Tailscale's `serve.json` to forward to Caddy's port instead of the app's. This is the one place the framework reasons about pairs of addons; nothing else needs to.
- Operator documentation page covering the Vault path layout and a worked example for one IdP (Entra ID).

Reversibility: forward-only if the addon is removed mid-flight from a live service — re-applying without `caddy-auth` restores the unprotected app, but in-flight authenticated sessions are dropped (Caddy's session state vanishes with the container). For a true rollback during the rollout window, removing the addon from the registry hides it from new use; existing applications must be unrolled per service.

UI changes:
- Stack detail page: rendered services list now shows a chain (app + caddy-auth, plus tailscale-web when present) with `network_mode` rewrites and reclaimed ports visible. [design needed] — how to convey "caddy owns the target's netns and reclaimed its ports" without operators having to read YAML.
- Operator docs page: Vault layout for `secret/connected-services/oidc/<provider>` plus a worked Entra ID example. [no design] — docs article.
- Auth-gated services display the IdP redirect chain on first request (anonymous → IdP → service). No new UI widget; operators see the existing Caddy 302 in the browser network tab when smoke-testing. [no design].

Done when: a service with `caddy-auth` plus `tailscale-web` enabled redirects unauthenticated browsers to the IdP, accepts authenticated users whose group membership matches `allowedGroups`, returns 403 for users who don't match, and forwards authenticated traffic transparently to the app. The rendered stack definition shows three services — app, caddy-auth, tailscale — with the right `network_mode` rewrites and reclaimed ports.

Verify in prod: at least one service deployed with `caddy-auth` rejects unauthenticated requests with the IdP redirect; an authenticated user in `allowedGroups` reaches the app; a user not in `allowedGroups` gets 403; no spike in IdP-side `failed_auth` events for 24 h after rollout.

### Phase 4 — Pool integration

**Goal:** addons declared on a `Pool` service materialise per instance at spawn time.

Deliverables:
- The pool spawner invokes the render pipeline with `instance: { instanceId }` populated, producing per-instance provisioned credentials and a per-instance `StackServiceDefinition` for each addon application.
- Per-instance sidecar containers created during pool spawn with the per-instance hostname convention; the pool instance container's `network_mode` (or the sidecar's, depending on `targetIntegration`) wired up accordingly.
- The pool reaper extension cleans up addon containers when instances are reaped and invokes addon `cleanup()` hooks.
- Container labelling: addon sidecars carry the same `mini-infra.stack-id` / `mini-infra.service` / `mini-infra.pool-instance-id` labels as the pool instance, plus `mini-infra.addon: <kind-or-id>` and `mini-infra.synthetic: true`.
- Connect panel pool-row expansion: clicking a pool service row reveals running instances with per-instance `ssh`/HTTPS rows.
- Egress-policy correctness for pools: per-instance addon sidecars emit `containerConfig.requiredEgress` that flows into the env's policy reconcile the same way static addon services do (§4.7) — verify this works when the pool service is in a firewalled env.

Reversibility: safe — pool addon support is additive. Pools without `addons:` declarations are unaffected. If addon provisioning fails for a pool instance, that single instance fails to spawn through the existing pool-spawn error path; remove the addon from the pool service definition to revert.

UI changes:
- Stack detail Connect panel: pool service rows expand to reveal per-instance rows, each with their own `ssh` / HTTPS row. [design needed] — disclosure pattern for a pool with N instances; how to handle 50-instance pools without flooding the panel.
- Containers page: per-instance addon sidecars appear with `mini-infra.synthetic` and `mini-infra.pool-instance-id` labels visible. [no design] — fits existing container-row label rendering.
- Pool detail: per-instance hostname (`{service}-{env}-{instance-id}`) shown alongside the existing instance-id column. [no design].

Done when: a pool service with `addons: { tailscale-ssh: {} }` spawns instances that each register as their own tailnet device with a unique per-instance hostname, an operator can SSH into a specific instance by name, and idle reaping removes both the worker container and the sidecar from Docker (and the device from the tailnet via ephemeral cleanup). In a firewalled env, the Tailscale control-plane hostnames appear as template-sourced rules and per-instance sidecars reach the tailnet without manual policy edits.

Verify in prod: at least one production pool service with `tailscale-ssh` shows N tailnet devices for N instances, names match the `{service-name}-{env-name}-{instance-id}` pattern, idle reaping removes both the worker container and the sidecar within the ephemeral-cleanup window, and pool resize events don't leave orphan devices behind.

### Phase 5 — UI polish and status surfacing

**Goal:** operators have a low-friction view of addon health and addressable endpoints.

Deliverables:
- Connect-panel improvements: per-pool-instance rows update live via the `tailscale` channel; copy-to-clipboard for `ssh` commands and URLs.
- An addon-status rollup on the stack detail header summarising addon health (provisioned / failed / pending) at a glance.
- A "Test connection" button per Tailscale-attached service that calls the Tailscale API to confirm the device is online and reports response time.
- Filter chip on the containers page using the `mini-infra.addon` and `mini-infra.synthetic` labels so operators can isolate (or hide) addon sidecars.

Reversibility: safe — pure UI; revert the PR.

UI changes:
- Stack detail header gains an "Addons" rollup pill ("3 healthy / 1 failed / 1 pending") clickable to open the Connect panel scrolled to the failed addon. [design needed] — pill style, colour rules, click target.
- Connect panel: copy-to-clipboard buttons next to every `ssh` command and HTTPS URL. [no design] — fits the existing copy-icon pattern from the API key page.
- Per-Tailscale-attached service: a "Test connection" button that calls the Tailscale API and displays response time inline. [no design] — fits the "Test" button pattern from connected services.
- Containers page: filter chip "Show synthetic addons" using `mini-infra.synthetic` and `mini-infra.addon` labels, defaulted to off. [design needed] — chip placement and the default-off vs default-on call.

Done when: the stack detail page surfaces the right URL for every addon-attached service (including pool instances), live online/offline transitions reflect within ~5s, and an operator can audit addon health for an entire stack from one screen.

Verify in prod: stack detail header surfaces the right addon count and health on a stack with mixed-state addons; live online/offline transitions reflect within ~5 s (measured against a deliberate device-down test); copy-to-clipboard click count rises in the events log (operators using it instead of selecting + copying by hand).

### Phase 6 — OIDC provider management UI (optional, deferred)

**Goal:** managing IdPs becomes a first-class connected-service concern instead of direct Vault editing.

Deliverables:
- A new `OidcProvider` model with admin UI for adding, editing, and testing IdPs.
- The `caddy-auth` addon's `provision` switches from direct Vault path lookup to `OidcProvider` resolution.
- A "test sign-in" affordance per provider that exercises the OAuth flow end-to-end and reports success or failure.

Reversibility: forward-only — once `caddy-auth` switches from direct Vault paths to `OidcProvider` resolution, services that authored against the old path break unless migrated. Ship with an "import from Vault" affordance and a documented migration step before flipping the resolution source.

UI changes:
- New `/connected-services/oidc-providers` admin page: list, add, edit, delete IdPs with provider-specific fields (Entra, Auth0, Google Workspace, generic OIDC). [design needed] — full new page; per-provider form layout; secret-rotation pattern.
- Per-provider "Test sign-in" button that opens the IdP redirect in a new tab and reports back round-trip success. [design needed] — modal/dialog showing the test result is a new pattern for the connected-services area.
- `caddy-auth` addon config gains a provider dropdown sourced from the new `OidcProvider` model. [no design] — slots into the existing addon-config form rendering.
- Connected Services page: new "OIDC Providers" entry alongside Tailscale / Cloudflare / etc. [no design] — fits the established connected-service card pattern.

Done when: an admin can add a new IdP through the UI, attach it to a service via `addons: { caddy-auth: { provider: <id> } }`, and verify the round trip from the connected-services page without editing Vault directly.

Verify in prod: at least one IdP added through the new UI is bound to a `caddy-auth` addon application and produces successful end-to-end sign-in; no operator edits against `secret/connected-services/oidc/<provider>` Vault paths after rollout (per the Vault audit log).

## 7. Risks & open questions

- **Connected Service config model.** Three Tailscale-specific columns on `ConnectedService` may be the wrong shape if other connected services need similar growth. Worth a 30-minute look at the existing connected-services directory before Phase 1 to decide between a shared-table extension and a per-type satellite table.
- **ACL bootstrap rendering.** JSON is parseable; HuJSON (Tailscale's commenting variant) is friendlier for the operator's eventual hand-editing but introduces a dependency. Default to JSON unless a user objects.
- **Caddy image provenance.** Building our own `caddy-auth-sidecar` pins the `caddy-security` plugin version and matches the existing sidecar pattern; pulling upstream `caddy:latest` is one less moving part. Mild preference for building, but worth confirming during Phase 3.
- **Pool instance Tailscale state volume.** Per-instance state volumes are cheap, but pool instances are short-lived and authkeys are minted per-spawn. With ephemeral nodes auto-cleaning, the volume is effectively write-only. Phase 4 should validate that skipping the volume on pool instances doesn't introduce a re-registration race, and pick the cleaner of the two paths.
- **Pool instance hostname collisions across stacks.** `worker-prod-u12345` in stack A and `worker-prod-u12345` in stack B produce duplicate device names in the tailnet. Per-stack tags prevent ACL crossover but the device list stays ambiguous. Phase 4 may need to prefix pool hostnames with the stack name and accept longer hostnames.
- **Funnel-shaped follow-up.** Once Tailscale-only HTTPS is shipped, the smallest extension to reach the public internet is enabling Tailscale Funnel. It overlaps the Cloudflare tunnel feature, so a deliberate "when do you pick which?" call is needed before any Phase 6+ extension touches Funnel.
- **Definition-hash determinism.** The rendered stack definition includes addon-derived services and target-integration rewrites. Provision values like authkeys are minted fresh on each render, which would oscillate the hash and force needless re-applies. Phase 1 must ensure the hash is computed from the *authored* definition (plus addon-config), not the rendered form, or that mint-once values are cached and reused across renders. Confirm during Phase 1 that the existing definition-hash logic naturally extends to the new field rather than drifting.
- **Synthetic-service surface in the UI.** Addon-derived services appearing in the same lists as user-authored ones is the whole point, but they need clear visual distinction (a "from addon" badge) and edit affordances should be disabled. Phase 1 should land at least the badge; Phase 5 polishes.

## 8. Linear tracking

Tracked under the [Service Addons — Tailscale and Caddy ingress addons](https://linear.app/altitude-devops/project/service-addons-tailscale-and-caddy-ingress-addons-a171d68a60ae) project on the Altitude Devops team. Phases land in order; each phase blocks the next.

- [ALT-38](https://linear.app/altitude-devops/issue/ALT-38) — Phase 1: Addon framework + Tailscale connected service + `tailscale-ssh`
- [ALT-39](https://linear.app/altitude-devops/issue/ALT-39) — Phase 2: `tailscale-web` and tailscale addon merging
- [ALT-40](https://linear.app/altitude-devops/issue/ALT-40) — Phase 3: `caddy-auth` v1
- [ALT-41](https://linear.app/altitude-devops/issue/ALT-41) — Phase 4: Pool integration
- [ALT-42](https://linear.app/altitude-devops/issue/ALT-42) — Phase 5: UI polish and status surfacing
- [ALT-43](https://linear.app/altitude-devops/issue/ALT-43) — Phase 6 (deferred): OIDC provider management UI
