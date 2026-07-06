# Network Access — Tailscale Ingress for Mini Infra's Own Control Plane

**Status:** planned, not implemented. Phased rollout — each phase ships as a separate PR.
**Builds on:** the shipped Tailscale addon framework (`tailscale-web`/`tailscale-ssh`, `TailscaleService`, `TailscaleAuthkeyMinter`) and the host-scoped stack + self-network-join mechanisms already used by the `vault`, `nats`, and `egress-fw-agent` stacks.
**Excludes:** Tailscale Funnel / public-internet exposure of the control plane — see Non-goals.

---

## 1. Background

Mini Infra's own control-plane container ships as a bare Docker Compose service (`deployment/production/docker-compose.yaml`), bound directly to a host port with no reverse proxy or TLS included — `DEPLOYMENT.md` tells operators to hand-roll nginx/Caddy/Traefik and ACME themselves if they want HTTPS. Meanwhile, Tailscale is already a mature, well-exercised integration for the *workloads* Mini Infra manages: the `tailscale-web`/`tailscale-ssh` addons, `TailscaleService`, ephemeral authkey minting, and self-provisioned TLS via `${TS_CERT_DOMAIN}` are all proven in production. Host-scoped stacks (`vault`, `nats`, `egress-fw-agent`) separately prove out the pattern of a system-owned stack whose container self-joins Mini Infra's own Docker network. This plan applies that same proven shape to Mini Infra's own front door — a `tailscale-ingress` host-scoped stack — and gives operators a single "Network Access" settings page that consolidates how Mini Infra itself is reached (Public URL, CORS, Docker Host IP) with a guided path to deploy, validate, and adopt the Tailscale ingress URL.

## 2. Goals

1. Operators can reach Mini Infra's own admin UI/API over HTTPS via their tailnet, with zero manual reverse-proxy or TLS configuration.
2. A single "Network Access" page is the one place to see and configure how Mini Infra is reached — Public URL, CORS, Docker Host IP, and Tailscale ingress status all live there.
3. Deploying Tailscale ingress reuses the exact credential, sidecar, and self-network-join mechanisms already proven for `vault`/`nats`/`tailscale-web` — no new pattern is introduced.
4. Adopting the tailnet address as the Public URL is a guided, low-friction step once ingress is validated as reachable — pre-filled, one save action — rather than a manual copy-paste exercise.

## 3. Non-goals

- **Tailscale Funnel / public-internet exposure of the control plane.** Mini Infra's container has full Docker socket access, so tailnet-private-only is the required safe default; a Funnel toggle is out of scope here.
- **Reusing/extending the per-service addon framework (`server/src/services/stack-addons/`).** That framework assumes its target is a reconciler-owned `StackServiceDefinition` tied to a user's stack; Mini Infra's own container is operator-launched via the static production compose file, not created through Mini Infra's own stack CRUD. The new stack's sidecar is reconciler-owned — that part's fine — but its target (Mini Infra's own container) is not, and must not need to be.
- **Trusting Tailscale identity headers (`Tailscale-User-Login`, etc.) for auth.** Google OAuth remains the sole auth mechanism; safely trusting those headers would require guaranteeing Mini Infra never accepts direct traffic on the public port, a separate and larger concern not addressed here.
- **Automatically closing off the existing host-port exposure once Tailscale ingress is live.** Locking down the `ports:` mapping in docker-compose is the operator's own deployment decision; this plan only adds the tailnet path as an option alongside it.
- **Leaving a redirect or deprecation notice at the old System Settings location** for the relocated Public URL / CORS / Docker Host IP fields. They simply move to the new page; no compatibility shim.

## 4. Shared concepts — host-scoped stacks and self-network-join

Both phases 1 and 3 (and the status display in phase 2) depend on these existing conventions, reused unmodified:

- **Host-scoped stack template convention.** A host-scoped stack is an ordinary system `StackTemplate` — a JSON file at `server/templates/<name>/template.json` with `"scope": "host"`, upserted into a `StackTemplate` row by the existing boot-time `syncBuiltinStacks`, then instantiated and applied through the same generic stack UI/API every user-authored template already uses. No bespoke TypeScript stack-building code is required.
- **Self-network-join.** A template service declares `resourceOutputs: [{ type: "docker-network", purpose: "<name>", joinSelf: true }]`. At apply time, `StackInfraResourceManager.joinSelfToOutputNetworks()` resolves Mini Infra's own container id (via the same `getOwnContainerId()` helper the self-update sidecar already uses) and calls `connectSelfToNetwork()` to attach it — idempotent, and `NetworkConvergenceScheduler` re-attaches after a container recreate. The `tailscale-ingress` template reuses this convention verbatim; it does not need to detect or name Mini Infra's Compose-default network.
- **Tailscale sidecar/credential shape.** Reused unmodified from `tailscale-web`: `TailscaleService` (OAuth-based connected service), `TailscaleAuthkeyMinter` (ephemeral, pre-authorized, non-reusable authkeys), the `tailscale/tailscale:stable` image with `NET_ADMIN`+`SYS_MODULE`, `TS_SERVE_CONFIG`-driven `serve.json` rendering, and `TailscaleService.getTailnetDomain()` for resolving the MagicDNS suffix.
- **Existing settings substrate.** `public_url`, `cors_enabled`, and `docker_host_ip` are already-existing DB-backed rows (category `"system"`) read via `server/src/lib/public-url-service.ts` (`getPublicUrl`, `isCorsEnabled`, and their cache-invalidation helpers) and edited via the existing system-settings form/API. This plan relocates their UI surface, not their storage or API contract.

## 5. Phased rollout

Phases land in strict sequence — each depends on the artifact the previous phase shipped.

### Phase 1 — `tailscale-ingress` host-scoped stack template

**Goal:** Mini Infra's own control-plane container is reachable over HTTPS via a tailnet address, through a new self-contained host-scoped stack.

Deliverables:
- A new system `StackTemplate` (`server/templates/tailscale-ingress/template.json`, `scope: "host"`) whose single service is a `tailscaled` sidecar carrying the same credential/container shape as the `tailscale-web` addon (authkey minting via `TailscaleService`/`TailscaleAuthkeyMinter`, `TS_SERVE_CONFIG`-driven `serve.json` proxying to Mini Infra's own container port).
- A `resourceOutputs`/`joinSelf` network declaration on the template so Mini Infra's own container self-joins the sidecar's network via the existing `connectSelfToNetwork()` mechanism — the same convention `vault`/`nats` already use.
- Whatever minimal apply-time credential-resolution wiring is needed to mint the Tailscale authkey for a static (non-addon) template — see §6 for the open question on whether an equivalent resolver already exists.

Reversibility: safe — a new, unused-until-deployed template; deploying it is itself reversible by destroying the stack.

UI changes:
- The new `tailscale-ingress` template appears as a selectable option in the existing generic host-stack template picker. [no design]

Schema changes: none — reuses the existing `StackTemplate.scope: "host"` enum value and the generic template-instantiation path.

Done when: an operator can instantiate and apply the `tailscale-ingress` template from the existing stack UI and reach Mini Infra's login page at the resulting `https://<name>.<tailnet>.ts.net` address.

Verify in prod: the `tailscale-ingress` stack shows `Synced` status and the tailnet's device list shows exactly one online device for it.

### Phase 2 — Network Access settings page, consolidating existing network settings

**Goal:** Public URL, CORS, Docker Host IP, and Tailscale ingress status all live on one dedicated page.

Deliverables:
- A new "Network Access" settings page that becomes the sole home for the `publicUrl`, `corsEnabled`, and `dockerHostIp` fields, relocated off the System Settings page (reusing the existing settings save logic and API unchanged — no new endpoints).
- A read-only status indicator on the same page for the `tailscale-ingress` stack (reflecting "not deployed" by default, or whatever state Phase 1's stack is actually in) — no deploy action yet.

Reversibility: safe — a UI relocation of existing, already-working settings, plus an additive read-only status view.

UI changes:
- Public URL, CORS, and Docker Host IP fields move from the System Settings page to the new Network Access page. [design needed]
- A new read-only Tailscale ingress status indicator on the Network Access page. [design needed]

Schema changes: none.

Done when: an operator can view and edit Public URL, CORS, and Docker Host IP exclusively from the Network Access page, and see the current Tailscale ingress status on the same page.

Verify in prod: the Network Access page is reachable in prod and correctly reflects "not deployed" for hosts that haven't applied the `tailscale-ingress` stack.

### Phase 3 — Deploy action, validation, and Public URL adoption

**Goal:** deploying and adopting Tailscale ingress is a single guided flow on the Network Access page.

Deliverables:
- A "Deploy Tailscale ingress" action on the Network Access page that applies the Phase 1 template without leaving the page.
- A validated/pending/error status for the deployed sidecar (device online, `tailscale serve` responding).
- A Public URL field pre-filled from the resolved tailnet MagicDNS domain (`TailscaleService.getTailnetDomain()`) that the operator saves in one action once validated.

Reversibility: safe — the deploy action wraps Phase 1's already-reversible stack apply; saving Public URL is a plain settings write the operator can change again at any time. (See §6 for the CORS-lockout risk this can trigger.)

UI changes:
- Deploy button and live status on the Network Access page. [design needed]
- Public URL pre-fill + save flow, plus a reminder to add the tailnet URL as an authorized Google OAuth redirect URI. [design needed]

Schema changes: none.

Done when: an operator can click Deploy on the Network Access page and, once the sidecar reports a validated online device, save the resulting tailnet URL as the Public URL without leaving the page.

Verify in prod: an operator who runs this flow ends up with Public URL pointing at a live `*.ts.net` address, confirmed by a successful login through that URL.

## 6. Risks & open questions

- Whether the static-template credential-resolution mechanism (the `dynamicEnv`-style wiring used by templates like `egress-fw-agent`) already supports minting a Tailscale authkey at apply time, or Phase 1 needs to add that resolver — not confirmed during this brainstorm.
- Saving a new Public URL while CORS restriction is already enabled immediately changes the allowed origin (`isCorsEnabled`/`createDynamicCorsOrigin` in `public-url-service.ts` only allow the current `publicUrl` as an origin) — an operator could lock themselves out of whatever origin they were previously using. Phase 3 should probably surface a warning at save time, but this plan doesn't mandate a specific UX for it.
- The exact alias/hostname Mini Infra's own container is reachable at once self-joined to the new network isn't nailed down here — Phase 1's implementer should mirror whatever alias convention `vault`/`nats` already rely on rather than inventing a new one.

## 7. Phase tracking

- [ ] Phase 1: `tailscale-ingress` host-scoped stack template
- [ ] Phase 2: Network Access settings page, consolidating existing network settings  [blocks-by: 1]
- [ ] Phase 3: Deploy action, validation, and Public URL adoption  [blocks-by: 2]
