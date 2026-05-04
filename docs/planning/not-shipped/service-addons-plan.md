# Service Addons Framework

**Status:** planned, not implemented. Phased rollout — each phase is a separate Linear issue.
**Builds on:** the existing `Pool` service type and stack-template plumbing ([`PoolConfig`](../../../lib/types/stacks.ts), [`pool-spawner.ts`](../../../server/src/services/stacks/pool-spawner.ts), [`pool-instance-reaper.ts`](../../../server/src/services/stacks/pool-instance-reaper.ts)), the connected-services pattern ([Docker / Azure / Cloudflare / GitHub](../../../server/src/services/connected-services/)), the `StackServiceDefinition` schema ([`lib/types/stacks.ts`](../../../lib/types/stacks.ts)), and Vault credential storage.
**Excludes:** outbound credential proxying — that work lives in the separate [auth-proxy-sidecar-plan.md](auth-proxy-sidecar-plan.md). Inbound auth-gating sidecars (Caddy / OIDC) were earlier in scope but were cut for scope reasons; if revived they belong in their own plan.
**Vendor reference:** Tailscale credential and ACL mechanics are documented in [docs/architecture/vendor/tailscale-auth.md](../../architecture/vendor/tailscale-auth.md) — Phases 2–5 implement against the OAuth-client-credentials flow described there. Read that doc before touching tag scoping, ACL snippets, scopes, or the device-status poller.

---

## 1. Background

Two feature requests for stack-deployed services share the same structural shape: attach a sidecar that handles a cross-cutting ingress concern. Operators want Tailscale SSH access without exposing port 22 or distributing keys; internal tools want a friendly `https://<name>.<tailnet>.ts.net` URL with auto-provisioned TLS. Each is "wrap the service with a sidecar"; without a framework, two bespoke template fields and two bespoke code paths grow in parallel. The Service Addons framework lets a stack service opt into one or more named capabilities by adding entries to a single `addons:` block, and lets the team ship a third (log shipping, volume backup, Prometheus exporter) by dropping a directory into `server/src/services/stack-addons/`.

User-friendliness was a stated design pressure. The cost of "add an addon" must be one line of YAML on the service definition; the cost of "connect to the resulting service from a developer laptop" must be effectively zero-config — Tailscale handles identity, MagicDNS handles hostnames, and the Mini Infra UI surfaces the address.

A second design pressure: addon containers are still containers. They need logs, exec, drift detection, restart policies, healthchecks, labels, deployment events, RBAC, and every other piece of plumbing we already provide for stack services. Re-implementing that surface for "addon containers" would duplicate a large slice of `server/src/services/stacks/`. Instead, addons declare their sidecars *as* `StackServiceDefinition`s and ride the existing reconciler.

## 2. Goals

1. **A declarative `addons:` block** on `StackServiceDefinition` accepting a map of addon-id → addon-config. `addons: { tailscale-ssh: {} }` is the minimum-viable form. The user's authored stack carries only this terse block — the addon-derived sidecars never appear in the user's stack definition on disk or in the DB.
2. **`AddonDefinition` wraps a `StackServiceDefinition`.** Each addon directory under `server/src/services/stack-addons/<id>/` exports a definition whose sidecar is described as a full `StackServiceDefinition`, so addon containers inherit logs / exec / drift detection / labels / events / RBAC for free. Adding an addon is dropping a directory.
3. **Pool-aware lifecycle.** Addons declared on a `Pool`-type service materialise per pool instance at spawn time, so each pool worker gets its own sidecar identity and per-instance hostname.
4. **Tailscale becomes a Connected Service** alongside Docker / Azure / Cloudflare / GitHub, with credential storage in Vault, connectivity probing, and an admin UI that emits a copy-paste ACL bootstrap snippet.
5. **Two v1 addons.** `tailscale-ssh` (operator SSH via tailnet identity) and `tailscale-web` (HTTPS exposure on the tailnet with auto-provisioned TLS).
6. **Friendly end-user surfaces.** The stack detail page exposes a "Connect" panel listing every addon-attached endpoint with one-click `ssh`/HTTPS, including per-pool-instance entries when expanded.

## 3. Non-goals

- **Multi-tailnet support.** v1 binds Mini Infra to one tailnet via one OAuth client. Operators with multiple tailnets are out of scope.
- **Auto-managing the tailnet ACL.** v1 emits a copy-paste snippet the operator pastes into their tailnet policy file; we do not call the Tailscale ACL API.
- **Tailscale Funnel (public exposure).** v1 ships `tailscale-web` in tailnet-only mode. Funnel overlaps the existing Cloudflare tunnel feature; deferred.
- **Inbound auth-gating sidecars.** Caddy + OIDC and any other inbound user-auth gate were earlier in scope and were cut. If revived, they belong in their own plan, not as v1 addons here.
- **User-defined addons.** Only addons in the registry are usable; addon authoring is not a user-facing feature.
- **Cross-stack addon composition.** Addons are scoped to one service in one stack. No "addon X depends on addon Y on a different stack."
- **Drift detection on tailnet devices.** Ephemeral nodes self-clean; a reconciler that detects "this Tailscale device exists but no longer corresponds to a running container" is deferred.
- **UI polish / status rollups.** v1 ships the initial pages only — no addon-status header pills, no copy-to-clipboard affordances, no "Test connection" button per addon, no synthetic-addon filter chips. Scoped out in favour of initial page development; revisit after operator feedback.

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
- **Provision hook.** Async function called before service-definition materialisation. Receives the addon config and full provision context; returns `ProvisionedValues` (env for sidecar, env for target, generated files, template variables) consumed by the materialisation step. This is where Tailscale authkeys are minted, sidecar config files rendered, and per-instance secrets generated.
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
7. **Reconcile.** The rendered stack definition flows into the existing reconciler unchanged.

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
2. **`requiredEgress` declarations flow through `containerConfig` automatically.** The egress-policy reconciler ([egress-policy-lifecycle.ts](../../../server/src/services/egress/egress-policy-lifecycle.ts)) reads `requiredEgress: string[]` off each service's `containerConfig` and seeds template-sourced rules. Because `AddonDefinition.buildServiceDefinition()` returns a full `StackServiceDefinition` whose `containerConfig` is just a `StackContainerConfig`, the addon declares its sidecar's required outbound destinations there — Tailscale's coordination plane (`*.tailscale.com`, `controlplane.tailscale.com`, DERP relays), the outbound auth proxy's upstream host list — and the existing reconciler picks them up alongside user-authored services' patterns. No new framework primitive, no parallel firewall code path.
3. **Fixed vs config-derived `requiredEgress`.** Tailscale has fixed control-plane dependencies — encode them as constants the addon's `buildServiceDefinition()` writes into `containerConfig.requiredEgress`. The outbound auth proxy is config-derived: `provision()` computes the upstream host list from the addon config and threads it through `templateVars` so `buildServiceDefinition()` can emit the right `requiredEgress`.

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
- **Each container's `requiredEgress` unions independently.** Target and sidecar are distinct service rows — their required-egress sets union at policy reconcile time. For the agent + auth-proxy case: agent declares its real upstreams, auth-proxy adds whatever it needs (e.g., a credential-fetch endpoint), policy picks up both.
- **Cross-addon ordering is irrelevant for egress.** Each container's outbound is independently firewalled by being on the egress network; addon attachment shape doesn't change that.

#### Implications for the framework

The framework deliverables don't grow — `containerConfig.requiredEgress` already exists on `StackContainerConfig` and the reconciler already reads it. What's required instead is documentation and a sanity check: the `tailscale-ssh` addon (Phase 3) must encode the right Tailscale control-plane hostnames in its `buildServiceDefinition()` output, and Phase 3's smoke tests should include "addon attached to a service in a firewalled env still functions, with the addon-declared hostnames showing up as template-sourced rules in the env's egress policy." Phase 6 verifies pool-instance addon services emit per-instance `requiredEgress` correctly.

## 5. The two v1 addons

Each addon below describes its `targetIntegration` shape, the `StackServiceDefinition` its `buildServiceDefinition()` produces (in shorthand), and the inputs flowing in from `provision()`.

### 5.1 `tailscale-ssh`

- **Kind:** `tailscale`. Merges with `tailscale-web` when both are present on the same service.
- **Requires:** Tailscale connected service.
- **Config:** optional `extraTags` (array of `tag:*` strings).
- **Target integration:** `network: "peer-on-target-network"`. The sidecar joins the same Docker network as the target so it can reach `<target>:<port>` by name. The target service is unmodified — no `network_mode` rewrite, no port reclamation.
- **Provision:** mint a one-time, ephemeral, preauthorized authkey via the OAuth-client-credentials flow (see [tailscale-auth.md](../../architecture/vendor/tailscale-auth.md)). Auth keys are tagged with the single static `tag:mini-infra-managed` (plus any user-supplied `extraTags` the operator has pre-declared in their `tagOwners` ACL). Per-resource identity is conveyed by the device hostname, **not** by additional dynamic tags — Tailscale OAuth clients can only mint keys with tags pre-declared in the operator's ACL `tagOwners`, so dynamic per-stack/per-env/per-service tags would force unbounded ACL edits. Returns `envForSidecar: { TS_AUTHKEY, TS_HOSTNAME }` and `templateVars: { tsExtraArgs: "--ssh" }`.
- **Sidecar `StackServiceDefinition`:** the official `tailscale/tailscale` image (containerised tailscaled, not embedded `tsnet` — `tsnet` is Go-only and we don't need it because the addon ships as a sidecar container, not a library inside the Node process), the provisioned env, a per-application state volume, no published ports, the standard mini-infra labels, `restart: unless-stopped`, and `containerConfig.requiredEgress` listing the Tailscale control-plane hostnames (`controlplane.tailscale.com`, `*.tailscale.com`, `*.tailscale.io`, DERP relay hostnames) so the egress-policy reconciler pre-allows them in firewalled envs (§4.7).
- **End-user surface:** `ssh root@<service>-<env>` from any tailnet-joined laptop. Authentication is the tailnet identity provider via the ACL `ssh` stanza configured during connected-service setup. Default ACL is `action: check` with a 12-hour `checkPeriod` — one IdP re-auth per workday.

### 5.2 `tailscale-web`

- **Kind:** `tailscale`.
- **Requires:** Tailscale connected service.
- **Config:** required `port` (local container port to expose); optional `path` (URL prefix, defaults to `/`).
- **Target integration:** `network: "peer-on-target-network"`. Same as `tailscale-ssh` — the sidecar reaches the app by service-name DNS over the shared Docker network. No target rewrite.
- **Provision:** mint authkey (same shape and single-tag scoping as `tailscale-ssh`); resolve the tailnet domain via the `GET /api/v2/tailnet/-` shorthand on the OAuth client (`-` = "the tailnet that owns this OAuth client" — see [tailscale-auth.md](../../architecture/vendor/tailscale-auth.md)); render a `serve.json` that terminates HTTPS on `${TS_CERT_DOMAIN}:443` and proxies to the target service's `port`. Returns the file under `files: [{ path: "/etc/tailscale/serve.json", … }]` and the env (`TS_AUTHKEY`, `TS_HOSTNAME`, `TS_SERVE_CONFIG=/etc/tailscale/serve.json`).
- **Sidecar `StackServiceDefinition`:** as for `tailscale-ssh` (including the same `requiredEgress` for the Tailscale control plane), plus a config-file mount populated from the provisioned `files`.
- **End-user surface:** `https://<service>-<env>.<tailnet>.ts.net` opens directly with auto-provisioned Let's Encrypt certs. No tunnel, no DNS configuration, no port-forwarding.
- **Merge with `tailscale-ssh`:** the registered `kind: tailscale` merge strategy emits one sidecar definition with both `--ssh` and `TS_SERVE_CONFIG` set, sharing one authkey, one hostname, one tailnet device, one state volume, one published serve.json.

### 5.3 Forward look: outbound auth proxy

Out of scope for this plan, but worth confirming the framework fits the next addon-shaped feature without further extension. The agent auth proxy ([auth-proxy-sidecar-plan.md](auth-proxy-sidecar-plan.md)) intercepts *outbound* HTTP from a target so it can inject upstream credentials. It maps to `network: "join-target-netns"` plus `envForTarget: { HTTP_PROXY, HTTPS_PROXY, NODE_EXTRA_CA_CERTS }` plus `mountsForTarget` for a CA bundle. Its `requiredEgress` is config-derived — `provision()` reads the user's upstream-host list from the addon config and the resulting `containerConfig.requiredEgress` rides into the egress-policy reconcile alongside the agent's own declarations (§4.7). No new framework primitive is required.

## 6. Phased rollout

Phases form a dependency graph (see the `[blocks-by: …]` brackets in §8). Phases 1–4 build the framework, the Tailscale connected service, and the two Tailscale addons against static services. Phase 5 ships the Connect panel and live device-status poller. Phase 6 generalises addons to pool services.

`[design needed]` UI items are picked up by `plan-to-linear` at seed time and materialised as paired `Backlog` design tickets that block their phase — designers own those tickets, kept out of `execute-next-task`'s queue.

### Phase 1 — Addon framework

**Goal:** the render pipeline expands `addons:` declarations into rendered `StackServiceDefinition`s, proven by a no-op test addon, with no production addon shipping yet.

Deliverables:
- The `AddonDefinition`, `AddonMergeStrategy`, `AddonManifest`, `TargetIntegration`, `ProvisionContext`, and `ProvisionedValues` types in `lib/` and `server/src/services/stack-addons/`.
- The addon registry — a single registration entry point under `server/src/services/stack-addons/` listing the active addons by id.
- The `addons` field on `stackServiceDefinitionSchema` with per-entry `superRefine` validation against the registered manifests.
- The render pipeline `expandAddons()` step running validation → applicability check → merge-group resolution → `provision` → `buildServiceDefinition` → target-integration application, called by the existing render step before reconcile.
- Synthetic-service flagging — rendered addon services carry `synthetic: true` and a back-reference to the target service.
- Two new Socket.IO event names on the `stacks` channel: `STACK_ADDON_PROVISIONED` and `STACK_ADDON_FAILED` (defined in `lib/types/socket-events.ts`; not yet emitted).
- A no-op test addon registered in test-only code that round-trips the validate → render → reconcile path in unit tests.
- Definition-hash logic confirmed to compute from the *authored* definition + addon-config, not the rendered form (per §7).

Reversibility: feature-flagged — addon expansion is a pure function of `addons:` declarations. With the production registry empty, the render pass is a no-op for every existing stack. Rollback is reverting the PR.

UI changes: none

Done when: a unit test registers a no-op test addon, applies a stack template with `addons: { noop: {} }` on a Stateful service, and asserts the rendered stack has the synthetic sidecar appended with `synthetic: true` while the target service remains unchanged; an authored stack with no `addons:` declarations round-trips through the render pipeline byte-identical to its authored form.

Verify in prod: `n/a — internal only`

### Phase 2 — Tailscale connected service

**Goal:** Mini Infra can authenticate to a Tailscale tailnet, mint authkeys, and report connectivity from the admin UI.

Deliverables:
- A new `tailscale` connected-service type alongside Docker / Azure / Cloudflare / GitHub.
- OAuth `client_credentials` access-token minter against `POST https://api.tailscale.com/api/v2/oauth/token`. Access tokens are short-lived (~3600 s); cache with pre-expiry refresh. Authoritative shape lives in [tailscale-auth.md](../../architecture/vendor/tailscale-auth.md).
- A server-side authkey minter calling `POST https://api.tailscale.com/api/v2/tailnet/-/keys` with `capabilities.devices.create = { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:mini-infra-managed", …] }` and a short `expirySeconds`. The `-` in the URL resolves to "the tailnet that owns this OAuth client"; the same trick is used for tailnet-domain auto-discovery.
- Tailscale connectivity prober wired into the existing `ConnectedServiceProber` — green = OAuth credentials successfully mint an access token.
- The Tailscale settings form on the connected-services admin page.
- The ACL bootstrap snippet box on the same form. The snippet must include (a) `tagOwners` granting the operator's admin group ownership of `tag:mini-infra-managed`, (b) a `grants` (or legacy `acls`) stanza permitting tailnet members to reach `tag:mini-infra-managed` devices, and (c) an `ssh` stanza with `action: check, checkPeriod: 12h` so Phase 3's `--ssh` flag works without further ACL edits. JSON by default; HuJSON is a follow-up.
- Vault path conventions for the OAuth client_id / client_secret.
- Admin documentation page walking operators through (i) creating an OAuth client at `https://login.tailscale.com/admin/settings/oauth` with scopes `auth_keys` (write) + `devices:core` (write), (ii) **assigning `tag:mini-infra-managed` to the OAuth client itself** (required — OAuth clients can only mint keys with tags they own), (iii) pasting the ACL snippet from the settings form into their tailnet policy file.

Reversibility: feature-flagged — Tailscale becomes opt-in. Without credentials configured, no behaviour changes anywhere in the system. Rollback is reverting the PR or removing the Tailscale connected-service entry.

UI changes:
- Connected Services page gains a "Tailscale" entry alongside Docker / Azure / Cloudflare / GitHub: connection status, last-checked timestamp, edit form. [no design] — fits the established connected-service card pattern.
- Settings: new "Tailscale" admin form with OAuth client_id / client_secret, default tags, click-to-copy ACL bootstrap snippet block. [design needed] — the snippet preview + tag list + copy block layout is new for our settings forms.
- New admin docs page walking operators through Tailscale OAuth client creation and ACL bootstrap. [no design] — uses the existing user-docs article shell.

Done when: an admin can configure Tailscale credentials via the new form, the connectivity prober shows green, and a server-side `mintAuthkey()` invocation from a test command produces a working tailnet authkey.

Verify in prod: Tailscale entry appears under Connected Services with a green status; no `tailscale.auth_failed` log spike for 24 h after rollout.

### Phase 3 — `tailscale-ssh` addon

**Goal:** operators can SSH into addon-attached static services using their tailnet identity.

Deliverables:
- The `tailscale-ssh` addon directory under `server/src/services/stack-addons/tailscale-ssh/` with its `AddonDefinition` (manifest, `targetIntegration: peer-on-target-network`, `provision`, `buildServiceDefinition`).
- The Tailscale state-volume convention for static services.
- Default tag scoping: the single static `tag:mini-infra-managed` (matching the tag the operator assigned to the OAuth client in Phase 2), plus any user-supplied `extraTags` the operator has separately added to their `tagOwners`. Per-resource identity comes from the device hostname, not from dynamic per-stack/per-env/per-service tags — see [tailscale-auth.md](../../architecture/vendor/tailscale-auth.md) for the OAuth-client tag-ownership constraint that rules out dynamic tagging.
- The static-service hostname rule `{service-name}-{env-name}` (sanitised, ≤63 chars).
- The materialised sidecar's `containerConfig.requiredEgress` lists the Tailscale control-plane hostnames (`controlplane.tailscale.com`, `*.tailscale.com`, `*.tailscale.io`, DERP relays), so the addon works in firewalled envs without manual policy edits (§4.7).
- The "from addon" badge rendered on synthetic services in the stack-detail and containers pages.
- `STACK_ADDON_PROVISIONED` and `STACK_ADDON_FAILED` events emitted by the render pipeline and surfaced under the existing apply task in the task tracker.

Reversibility: feature-flagged — only services that opt in via `addons: { tailscale-ssh: {} }` are affected. Removing the addon from the service definition unrolls the sidecar on next apply. Tailnet device de-registration via ephemeral cleanup leaves no residual state.

UI changes:
- Stack detail / Containers page: addon-derived sidecars appear in the existing service/container lists with a "from addon" badge and a back-reference to the target service; edit affordances disabled. [design needed] — badge style and how a synthetic sidecar visually relates to its target row (indented? linked icon?) needs a designer call.
- Stack apply flow: live progress reflects `STACK_ADDON_PROVISIONED` / `STACK_ADDON_FAILED` under the existing apply task in the task tracker. [no design] — slots into existing task-tracker step rendering.

Done when: a stack template with `addons: { tailscale-ssh: {} }` on a Stateful or StatelessWeb service applies cleanly, the synthetic sidecar joins the tailnet under the right tags, shows up on the containers page with the "from addon" badge and working logs/exec, and `ssh root@<service>-<env>` from a tailnet-joined laptop succeeds via the ACL-driven `check` flow — including in an env with `egressFirewallEnabled: true`, where the Tailscale control-plane hostnames must appear as template-sourced rules without manual policy edits.

Verify in prod: the first stack applied with `addons: { tailscale-ssh: {} }` shows the sidecar online in the Tailscale admin console under `tag:mini-infra-managed`; no spike in `STACK_ADDON_FAILED` events for 24 h after rollout.

### Phase 4 — `tailscale-web` and tailscale addon merging

**Goal:** services can expose HTTPS on the tailnet with auto-provisioned TLS, and both Tailscale addons run together as a single sidecar when both are declared.

Deliverables:
- The `tailscale-web` addon directory with manifest, `targetIntegration: peer-on-target-network`, `provision` (renders `serve.json` from port/path config and resolves the tailnet domain), and `buildServiceDefinition` (config-file mount for `serve.json`; reuses Tailscale control-plane `requiredEgress` from Phase 3).
- An `AddonMergeStrategy` registered for `kind: tailscale`: when `tailscale-ssh` and `tailscale-web` both target the same service, one sidecar definition carries both `--ssh` and `TS_SERVE_CONFIG`, sharing one authkey, one hostname, one tailnet device, and one state volume.

Reversibility: feature-flagged — opt-in per service. Removing the addon unrolls on next apply. Merging is automatic when both Tailscale addons are declared on the same service.

UI changes: none — the operator-visible difference (one merged sidecar instead of two) is a side-effect of the rendered definition; the user-friendly Connect-panel surface ships in Phase 5.

Done when: a service with both `tailscale-ssh` and `tailscale-web` declared exposes one merged sidecar in the rendered stack, exactly one Tailscale device exists in the tailnet for that service, and both `ssh root@<host>` and `https://<host>.<tailnet>.ts.net` work end-to-end (verified via the tailnet admin console plus manual `ssh`/`curl` from a tailnet-joined laptop).

Verify in prod: at least one production service is reachable via both `ssh` and `https://…ts.net`; tailnet device count matches the number of `tailscale-*` addon applications recorded in the DB.

### Phase 5 — Connect panel + Tailscale device-status poller

**Goal:** operators see every addon-attached endpoint with one-click `ssh`/HTTPS actions and live online/offline status.

Deliverables:
- A Tailscale device-status poller as a server-side scheduled task; emits `TAILSCALE_DEVICE_ONLINE` / `TAILSCALE_DEVICE_OFFLINE` events.
- A new `tailscale` Socket.IO channel for those events, defined in `lib/types/socket-events.ts`.
- The Connect panel on the stack-detail page: rows per addon-attached endpoint with `ssh root@…` / `https://…` actions and live status badges.
- The new `tailscale` channel surfaced via the existing connection-status indicator alongside the other channels.

Reversibility: safe — additive UI plus a new background poller. Disabling the poller stops emitting events and the panel falls back to last-known state. Rollback is reverting the PR.

UI changes:
- Stack detail page: new Connect panel listing every addon-attached endpoint with one-click `ssh root@…` and `https://…` actions, with live online/offline status badges. [design needed] — brand-new panel; placement relative to the services list, empty / failed / loading states all need design.
- Live status badge style (green / grey / red dot) and the transition timing pattern. [design needed].
- Existing connection-status indicator surfaces the `tailscale` channel alongside the others. [no design] — fits the established pattern.

Done when: a service with both Tailscale addons enabled has a Connect panel row that renders within ~1 s, and badges flip within ~5 s of a deliberate device-down test in the tailnet admin console.

Verify in prod: at least one production service with `tailscale-web` has the Connect panel rendering correct URLs; live online/offline transitions reflect within ~5 s (measured against a deliberate device-down test).

### Phase 6 — Pool integration

**Goal:** addons declared on a pool service materialise per pool instance at spawn time.

Deliverables:
- `pool-spawner.ts` invokes the render pipeline with `instance: { instanceId }` populated, producing per-instance provisioned credentials and per-instance `StackServiceDefinition`s for each addon application.
- Per-instance hostname rule `{service-name}-{env-name}-{instance-id}` (sanitised, ≤63 chars; `instance-id-sha256[:8]` fallback when oversized).
- Per-instance addon sidecars carry `mini-infra.stack-id`, `mini-infra.service`, `mini-infra.pool-instance-id`, `mini-infra.addon: <kind-or-id>`, and `mini-infra.synthetic: true` labels.
- `pool-instance-reaper.ts` extension: invokes addon `cleanup()` hooks and removes addon sidecar containers when instances are reaped.
- Per-instance addon sidecars emit `containerConfig.requiredEgress` flowing into the env's policy reconcile the same way static addon services do (§4.7).
- The pool-row disclosure on the Connect panel: pool service rows expand to show per-instance rows with their own `ssh` / HTTPS actions.
- Per-instance hostname displayed alongside the existing instance-id column on the pool detail page.

Reversibility: safe — pool addon support is additive. Pools without `addons:` declarations are unaffected. Per-instance provisioning failures fail through the existing pool-spawn error path.

UI changes:
- Stack detail Connect panel: pool service rows expand to per-instance rows, each with their own `ssh` / HTTPS actions. [design needed] — disclosure pattern for a pool with N instances; how to handle 50-instance pools without flooding the panel.
- Containers page: per-instance addon sidecars appear with `mini-infra.synthetic` and `mini-infra.pool-instance-id` labels visible. [no design] — fits existing container-row label rendering.
- Pool detail: per-instance hostname (`{service}-{env}-{instance-id}`) shown alongside the existing instance-id column. [no design].

Done when: a pool service with `addons: { tailscale-ssh: {} }` spawns N instances, each registers as its own tailnet device with the per-instance hostname pattern, an operator can SSH into a specific instance by name, and idle reaping removes both the worker container and the sidecar (and the device from the tailnet via ephemeral cleanup) — including in a firewalled env where per-instance sidecars must reach the tailnet without manual policy edits.

Verify in prod: at least one production pool service with `tailscale-ssh` shows N tailnet devices for N instances, names match the `{service-name}-{env-name}-{instance-id}` pattern, and idle reaping removes both worker and sidecar within the ephemeral-cleanup window without orphan devices.

## 7. Risks & open questions

- **Connected Service config model.** Three Tailscale-specific columns on `ConnectedService` may be the wrong shape if other connected services need similar growth. Worth a 30-minute look at the existing connected-services directory before Phase 2 to decide between a shared-table extension and a per-type satellite table.
- **ACL bootstrap rendering.** JSON is parseable; HuJSON (Tailscale's commenting variant) is friendlier for the operator's eventual hand-editing but introduces a dependency. Default to JSON unless a user objects.
- **Pool instance Tailscale state volume.** Per-instance state volumes are cheap, but pool instances are short-lived and authkeys are minted per-spawn. With ephemeral nodes auto-cleaning, the volume is effectively write-only. Phase 6 should validate that skipping the volume on pool instances doesn't introduce a re-registration race, and pick the cleaner of the two paths.
- **Pool instance hostname collisions across stacks.** `worker-prod-u12345` in stack A and `worker-prod-u12345` in stack B produce duplicate device names in the tailnet. Because all devices share the single `tag:mini-infra-managed` (see the tag-taxonomy note below), the device list is the only disambiguator — Phase 6 likely needs to prefix pool hostnames with the stack name and accept longer hostnames (with the SHA-256 fallback already in §4.5 catching DNS-label overflow).
- **Tag taxonomy is single-tag, not hierarchical.** Earlier drafts of §5.1 / §5.2 minted authkeys with `tag:stack-<id>,tag:env-<env>,tag:service-<name>` — infeasible because Tailscale OAuth clients can only mint keys with tags pre-declared in the operator's `tagOwners` ACL, and dynamic resource tags would force unbounded ACL edits. v1 ships with one static `tag:mini-infra-managed` and conveys per-resource identity via hostname. If a future need emerges (e.g. ACL rules that scope SSH access to specific environments), revisit by introducing a small fixed set of operator-declared environment tags rather than going fully dynamic.
- **Funnel-shaped follow-up.** Once Tailscale-only HTTPS is shipped, the smallest extension to reach the public internet is enabling Tailscale Funnel. It overlaps the Cloudflare tunnel feature, so a deliberate "when do you pick which?" call is needed before any post-v1 extension touches Funnel.
- **Definition-hash determinism.** The rendered stack definition includes addon-derived services and target-integration rewrites. Provision values like authkeys are minted fresh on each render, which would oscillate the hash and force needless re-applies. Phase 1 must ensure the hash is computed from the *authored* definition (plus addon-config), not the rendered form, or that mint-once values are cached and reused across renders. Confirm during Phase 1 that the existing definition-hash logic naturally extends to the new field rather than drifting.
- **Synthetic-service surface in the UI.** Addon-derived services appearing in the same lists as user-authored ones is the whole point, but they need clear visual distinction (a "from addon" badge) and edit affordances should be disabled. Phase 3 lands the badge; further polish (status rollup, filter chips, copy-to-clipboard affordances) was scoped out — revisit after operator feedback if friction surfaces.

## 8. mk tracking

Tracked under the `service-addons-framework` feature in mk.

- MINI-16 — Phase 1: Addon framework
- MINI-1 — Phase 2: Tailscale connected service  [blocks-by: 1]
- MINI-2 — Phase 3: `tailscale-ssh` addon  [blocks-by: 1, 2]
- MINI-3 — Phase 4: `tailscale-web` and tailscale addon merging  [blocks-by: 3]
- MINI-4 — Phase 5: Connect panel + Tailscale device-status poller  [blocks-by: 4]
- MINI-8 — Phase 6: Pool integration  [blocks-by: 3]

Cancelled (caddy-auth + OIDC scope cut): MINI-5, MINI-6, MINI-7 (caddy-auth phases); MINI-32, MINI-33, MINI-34, MINI-35 (OIDC provider management); MINI-25, MINI-36, MINI-37 (paired design tickets).
