# Claude Shell — Tailscale-SSH-enabled developer container with Claude Code baked in

**Status:** planned, not implemented. Phased rollout — each phase is a separate mk issue.
**Builds on:** the shipped Service Addons framework under [`server/src/services/stack-addons/`](../../../server/src/services/stack-addons/) — specifically the `tailscale-ssh` addon's credential plumbing (`TailscaleAuthkeyMinter`, OAuth client_id/secret in `ConfigurationService`, the `{stack}-{service}-{env}` hostname convention via `sanitizeTailscaleHostname`, and the control-plane `requiredEgress` rules). The pool-instance work in [`service-addons-plan.md`](./service-addons-plan.md) (Phase 6 / MINI-48) is the most recent in-flight phase of that framework.
**Excludes:** Anthropic credential brokering, web-IDE UI, multi-user shared shells — see §3.
**Vendor reference:** [Tailscale GitHub issue #5215](https://github.com/tailscale/tailscale/issues/5215) — confirms `tailscaled --ssh` terminates wherever the daemon runs and cannot be configured to proxy/bastion to a peer container; this rules out the existing sidecar shape for the "SSH lands in the agent container" outcome.

---

## 1. Background

Mini Infra already runs an addon framework that mints ephemeral Tailscale auth keys and attaches a `tailscaled` sidecar to selected services for SSH access. The sidecar terminates SSH at the daemon container, which is the right call when operators want to inspect a running app from the outside — but it's the wrong call for a developer-shell experience where the user needs to SSH directly into the container that has Claude Code installed, edit files, and operate on a cloned workspace. Tailscale's docs (issue #5215) confirm there's no proxy or bastion mode for `--ssh`.

This plan introduces a new top-level `claude-shell/` container image that bakes `tailscaled` + Claude Code CLI + git + tini together so SSH lands directly in the working container, plus a small generalisation of the addon framework so an addon can inject env vars (and required egress) into a target service instead of materialising a sidecar. All credential plumbing — auth-key minting, OAuth-backed minting, identity-named hostnames, control-plane egress firewall integration — is reused unchanged from the existing `tailscale-ssh` addon. Workspace bootstrap supports an optional git-repo clone on first start using an SSH deploy key stored in Vault. The user authenticates Claude Code at runtime by running `claude login` interactively in their SSH session; the OAuth tokens persist on the per-instance workspace volume.

The user-facing surface is a "Claude Shell" tile on the Applications page that pre-fills the new image + the new addon and (optionally) a git-repo URL plus an uploaded deploy key. After applying, the stack's Connect panel shows the SSH command pointed at the tailnet hostname of the shell container.

## 2. Goals

1. Operators can spin up a "Claude Shell" application from the Applications page and SSH directly into the agent container via their tailnet identity.
2. The new container honours the egress firewall integration — Tailscale control-plane reachability and git-host egress flow through the existing policy reconciler with no manual edits in firewalled environments.
3. The addon framework supports an env-injection mode where an addon's outputs land on the target service instead of materialising a sidecar, reusable beyond Claude Shell.
4. Anthropic credentials are never stored on the Mini Infra host — `claude login` runs interactively in the user's SSH session and persists to the per-instance workspace volume.
5. Optional git-clone bootstrap uses Vault-stored deploy keys; private repos work without operators copying private keys into stack env-var blocks.

## 3. Non-goals

- **No new "application type" registry.** Applications today are stack-service definitions, not typed entities; we don't introduce a registry just for this. Why: the existing preset-tile pattern matches the codebase, and a meta-framework with one user would invite the abstraction-debt trap.
- **No Anthropic-API-key brokering.** Mini Infra doesn't store, proxy, or rotate the user's Anthropic credentials. Why: keeps the Anthropic data plane out of Mini Infra's threat model and removes a moving part nobody asked for.
- **No multi-user SSH inside one container.** One Claude Shell = one Tailscale identity = one user's shell, not a shared bastion. Why: simplifies ACL design and matches how `tailscale-ssh` already attributes sessions. Pool-style "spawn an N-instance shell pool" is a future follow-up, not v1.
- **No bundled Claude Code MCP server install.** The image ships the CLI only; users install MCP servers inside their workspace if they want them. Why: keeps the image small and avoids tracking the MCP ecosystem in our release cadence.
- **No web-IDE UI.** SSH is the only interaction surface. Why: SSH already covers everything Claude Code needs interactively, and the image stays a single-purpose artefact.

## 4. Shared concepts

### 4.1 Env-injection addon mode

Phase 2 generalises the `AddonDefinition` contract with a `mode: 'sidecar' | 'env-injection'` field on the manifest. Existing addons (`tailscale-ssh`, `tailscale-web`) stay on `'sidecar'`; new env-injection addons declare `'env-injection'` and use it in place of `buildServiceDefinition()`.

Provisioned outputs split by mode:

- **`mode: 'sidecar'`** — unchanged. `provision()` returns `envForSidecar`, `buildServiceDefinition()` materialises the synthetic peer.
- **`mode: 'env-injection'`** — `provision()` returns `envForTarget`, optional `mountsForTarget`, optional `labelsForTarget`, plus `requiredEgress`. The `expand-addons.ts` render pass merges these into the target service's `containerConfig.env`, `containerConfig.mounts`, `containerConfig.requiredEgress`, and `dockerLabels`. No synthetic sidecar is produced.

Phases 3, 4, 5, 6 all consume this contract.

### 4.2 Tailscale identity reuse

The `claude-shell` addon reuses the credential plumbing of `tailscale-ssh` verbatim:

- `TailscaleAuthkeyMinter.mint()` for the per-instance, ephemeral, pre-authorized authkey.
- `sanitizeTailscaleHostname(stackName, serviceName, envSlug)` for the device hostname (FNV-1a-32 hash fallback when oversized; identical to the existing addon).
- The `TAILSCALE_CONTROL_PLANE_HOSTNAMES` list from `@mini-infra/types` for the egress firewall's `requiredEgress` block — except now applied to the target service rather than a sidecar.

Phases 3, 4, 6 all reference this convention.

### 4.3 Git deploy key Vault path

When the optional workspace clone uses a private repo, the SSH deploy key lives in Vault KV at:

```
stacks/${stackId}/services/${serviceName}/git-deploy-key
```

Stored as a single field `privateKey` (PEM). The path is convention-derived, not stored on the `StackService` row — the addon's `provision()` checks for the path's existence at apply time. Phases 5, 6 reference this.

### 4.4 Container entrypoint env contract

The `claude-shell` container reads these env vars at start:

| Env var | Source | Required | Effect |
|---|---|---|---|
| `TS_AUTHKEY` | claude-shell addon | yes | tailscaled login key |
| `TS_HOSTNAME` | claude-shell addon | yes | tailscaled `--hostname` |
| `TS_EXTRA_ARGS` | claude-shell addon | yes | always `--ssh` for now |
| `GIT_REPO_URL` | addon config | no | first-start workspace clone |
| `GIT_SSH_KEY` | claude-shell addon (from Vault) | no | SSH deploy key for the clone |
| `WORKSPACE_DIR` | container default | no | defaults to `/workspace` |

Persistent volumes:

- `/workspace` — git clone + user edits
- `/home/claude` — `claude login` OAuth tokens, shell history, MCP server installs

## 5. Phased rollout

Phases 1 and 2 fan out from the start in parallel (image work vs framework work — separate surfaces). Phase 3 needs both. Phases 4 and 5 fan out from Phase 3 in parallel (Connect-panel UI vs Vault git-key plumbing). Phase 6 wires the UI create flow on top of all four. Phase 7 ships operator docs.

### Phase 1 — `claude-shell/` container image

**Goal:** ship a standalone container image that runs `tailscaled --ssh` and exposes Claude Code, git, and a persistent workspace, runnable end-to-end with only Tailscale env vars supplied.

Deliverables:
- Top-level `claude-shell/` folder with a Dockerfile, entrypoint script, `package.json` (for any small Node helpers), and README. Standalone — not in the pnpm workspace; mirrors the `update-sidecar/` / `agent-sidecar/` precedent.
- Image base: lightweight Linux (e.g. `tailscale/tailscale:stable` derived or Alpine + `tailscale` apk) with the Claude Code CLI installed, git, openssh-client, and tini as PID 1.
- Entrypoint script that consumes the env contract from §4.4 — starts `tailscaled` in the background, waits for the device to register, optionally writes `GIT_SSH_KEY` and clones `GIT_REPO_URL` into `WORKSPACE_DIR`, then blocks so the container stays up under tini.
- Root `pnpm build:claude-shell` script following the `build:sidecar` / `build:agent-sidecar` pattern (npm under the hood for the standalone package), producing a buildable artefact locally.
- GHCR publish step in the existing release tooling — image tag `ghcr.io/mrgeoffrich/mini-infra-claude-shell:<version>` aligned with the rest of the platform's tag scheme.
- Entrypoint emits a clear, non-zero-exit error message if it can't reach the Tailscale control plane (so failures in egress-firewalled environments surface fast rather than hanging).
- Persistent-volume layout for `/workspace` and `/home/claude` declared in image metadata (`VOLUME` directives) so consuming stacks can mount them.

Reversibility: safe — new top-level folder with no server-side consumers. Deleting the folder reverts the change.

UI changes: none.

Schema changes: none.

Done when: a `docker run` of the published image with valid `TS_AUTHKEY` / `TS_HOSTNAME` / `TS_EXTRA_ARGS='--ssh'` env vars produces a container that registers a device on the operator's tailnet and accepts an inbound SSH session that lands inside the container with `claude --version` resolving.

Verify in prod: at least one `claude-shell` image tag visible in GHCR and pullable from a production host with the existing image-pull credentials.

### Phase 2 — Addon framework env-injection mode

**Goal:** the `AddonDefinition` contract supports an env-injection mode that merges provisioned outputs into the target service instead of materialising a sidecar, with existing sidecar-mode addons unchanged.

Deliverables:
- New `mode: 'sidecar' | 'env-injection'` field on `AddonDefinition.manifest`, defaulting to `'sidecar'` for back-compat.
- `ProvisionedValues` split per §4.1: env-injection addons return `envForTarget` / `mountsForTarget` / `labelsForTarget` / `requiredEgress` instead of `envForSidecar`.
- `expand-addons.ts` extended with the env-injection branch — merges the provisioned outputs into the target service's `containerConfig.env`, `containerConfig.mounts`, `containerConfig.requiredEgress`, and `dockerLabels`, then skips `buildServiceDefinition()`.
- Target service gets a `mini-infra.addon: <addon-id>` label so endpoint discovery (Phase 4) can find env-injection addons without scanning manifests.
- Unit tests covering: (a) existing `tailscale-ssh` and `tailscale-web` paths produce byte-identical synthetic sidecars, (b) a fixture env-injection addon merges outputs into the target service, (c) `requiredEgress` from an env-injection addon flows into the env's egress policy reconciler.
- No production addon uses `mode: 'env-injection'` yet — Phase 3 is the first consumer.

Reversibility: feature-flagged by construction — the new mode is opt-in per addon manifest; no existing addon switches modes in this phase.

UI changes: none.

Schema changes: none.

Done when: the addon framework accepts a `mode: 'env-injection'` manifest and routes provisioned env/mounts/labels/requiredEgress through to the target service, with existing sidecar-mode addons exercised in tests as a regression guard.

Verify in prod: existing `tailscale-ssh` and `tailscale-web` deployments remain healthy and no addon-expansion errors appear in the apply-route logs after the rollout.

### Phase 3 — `claude-shell` addon (server-side)

**Goal:** an admin can attach a `claude-shell` addon to a stack service running the new image, and after apply the container is reachable via Tailscale SSH using identity-based auth, with control-plane egress automatically allowed in firewalled environments.

Deliverables:
- New addon directory `server/src/services/stack-addons/claude-shell/` with `manifest.ts`, `provision.ts`, and `index.ts` (self-registers into `productionAddonRegistry`).
- Manifest: `id: 'claude-shell'`, `kind: 'claude-shell'`, `mode: 'env-injection'`, `appliesTo: ['Stateful', 'StatelessWeb']`, `requiresConnectedService: 'tailscale'`, config Zod schema covering optional `gitRepo` + `extraTags`.
- `provision()` reuses `TailscaleAuthkeyMinter.mint()`, computes the `{stack}-{service}-{env}` hostname via the shared sanitiser, sets `TS_EXTRA_ARGS='--ssh'`, and returns `envForTarget` with `TS_AUTHKEY` / `TS_HOSTNAME` / `TS_EXTRA_ARGS` plus optional `GIT_REPO_URL`.
- Provisioned `requiredEgress` lists the Tailscale control-plane hostnames from `@mini-infra/types`, applied to the target service so the env's egress-firewall reconciler opens the right holes without manual policy edits.
- Target service is labelled `mini-infra.addon: 'claude-shell'` for downstream endpoint discovery in Phase 4.
- Addon does not provision the git deploy key in this phase (Phase 5 adds that); `GIT_SSH_KEY` is absent unless Phase 5 has shipped.

Reversibility: feature-flagged — the addon registers, but no UI surface attaches it; an admin would have to author the addon block by hand to use it.

UI changes: none.

Schema changes: none.

Done when: hand-crafting a stack with the `claude-shell` image and `addons: { 'claude-shell': {} }` and applying it results in the agent container reachable over Tailscale SSH from the operator's tailnet, in both a firewall-disabled and a firewall-enabled environment.

Verify in prod: at least one production stack with the addon attached shows a tailnet device under the `{stack}-{service}-{env}` naming convention and an operator can SSH into it directly.

### Phase 4 — Connect-panel SSH URL for `claude-shell`

**Goal:** the Connect panel for a stack with the `claude-shell` addon surfaces a copy-pastable SSH command that targets the agent container directly (no sidecar in the loop).

Deliverables:
- `stacks-addon-endpoints-route.ts` extended with an env-injection branch that recognises target services labelled `mini-infra.addon: 'claude-shell'` (rather than scanning for `synthetic` service rows, which env-injection mode doesn't produce).
- Endpoint output for the `claude-shell` addon: `ssh root@<hostname>.<tailnet>` formatted using the existing hostname-sanitiser + tailnet org-name resolution path the `tailscale-ssh` row already uses.
- Connect-panel row component for the new addon — copy-to-clipboard button, addon icon, status indicator pulling from the existing addon status hook.

Reversibility: safe — purely additive; no migration of existing rows.

UI changes:
- Stack detail Connect panel: a new row for stacks with the `claude-shell` addon, showing the SSH command and a copy button. [design needed] — row styling for the Claude Shell addon, follows the established pattern in [`docs/designs/mini-23-addon-row-styling.md`](../designs/mini-23-addon-row-styling.md).

Schema changes: none.

Done when: the Connect panel for a stack with the `claude-shell` addon renders an SSH row whose copy button produces a command that successfully opens an SSH session to the agent container.

Verify in prod: an operator opens the Connect panel of a production Claude Shell stack, copies the SSH command, and connects on first try.

### Phase 5 — Vault-stored git deploy key

**Goal:** operators can upload an SSH private key for a private git repo via API; on next apply, the agent container clones the repo into the workspace on first start.

Deliverables:
- Server route to write/rotate/delete the SSH deploy key at the Vault path `stacks/${stackId}/services/${serviceName}/git-deploy-key` (single `privateKey` field) using the existing `VaultKVService`. Auth-gated to the same permissions that allow editing the stack.
- `VaultCredentialInjector`-style read at apply time: if the convention path exists for the target service, the `claude-shell` addon's `provision()` emits `GIT_SSH_KEY` in `envForTarget` (sourced from the `vault-kv` injector with the field `privateKey`). Existing Phase-1 entrypoint already consumes `GIT_SSH_KEY`.
- Delete-key path triggers a re-apply so the env var clears from the running container on the next reconcile.
- Note in addon docs: operators must declare any non-Tailscale egress (e.g. `github.com:22` for SSH clones, `github.com:443` for HTTPS clones) in their env's egress policy. Auto-deriving git-host egress from `GIT_REPO_URL` is out of scope for this phase — see §6.

Reversibility: safe — no consumers without the deploy key configured; rotation and delete are explicit operator actions.

UI changes: none — UI for the upload lands in Phase 6; until then operators curl the API.

Schema changes: none. Configuration lives in the existing `addons` JSON column (config schema gains a boolean-derived `hasGitDeployKey` view at apply time, not a stored field) and Vault KV; no Prisma migration.

Done when: an operator uploads an SSH deploy key for a private repo via the new API, configures the stack's `claude-shell` addon with a `gitRepo` pointing at that repo, applies, and the agent container clones the repo into `/workspace` on first start.

Verify in prod: at least one production Claude Shell with a private repo shows a populated `/workspace` directory on first SSH login.

### Phase 6 — Applications-page "Claude Shell" preset + create flow

**Goal:** operators create a Claude Shell from the Applications page with a tile-driven form (name, environment, optional git URL, optional deploy-key upload, optional tailnet tags), and the resulting stack is healthy and reachable via SSH end-to-end.

Deliverables:
- New tile on the Applications catalog page for "Claude Shell" alongside the existing presets.
- Create form fields: name, target environment, optional `gitRepo` URL, optional file upload for the SSH deploy key, optional `extraTags` for the tailnet device.
- Submission builds a `StackServiceDefinition` with the published `claude-shell` image + a `claude-shell` addon block pre-populated, then submits via the existing stack-apply pipeline. Successful create redirects to the stack detail page.
- If a deploy key was uploaded, the submission handler also writes it to the Vault path from §4.3 via the Phase 5 API before the apply.
- Server integration smoke test exercising the end-to-end path: create via the API, wait for healthy, simulate an SSH connect via the tailnet hostname, verify the workspace is populated when a repo is configured.

Reversibility: safe — no preset in the catalog before this phase; the underlying stack-apply path is unchanged.

UI changes:
- Applications catalog: new "Claude Shell" tile alongside the existing application presets. [design needed] — tile artwork, copy, icon, "what is this" subtext.
- Applications → New Claude Shell form: name, environment selector, optional git repo URL, optional SSH deploy key upload, optional extra tailnet tags. [design needed] — form layout, file-upload affordance for the SSH key, validation states.

Schema changes: none.

Done when: an operator creates a Claude Shell via the Applications page, the stack reaches a healthy state, the operator SSHes into the container using the Connect-panel command, and the configured private repo is cloned in `/workspace` — exercised end-to-end by the integration smoke test in CI.

Verify in prod: at least one Claude Shell created end-to-end via the UI in production, container healthy, an operator successfully SSHes in.

### Phase 7 — Operator docs

**Goal:** operators have a single onboarding page that walks them through creating a Claude Shell, including egress-firewall awareness, ACL recommendations, and how `claude login` works on first connect.

Deliverables:
- New user-docs page under `docs/user/claude-shell.md`, surfaced via the existing in-app help index.
- Sections: what a Claude Shell is, prerequisites (Tailscale connected service, OAuth client), creating one from the Applications page, SSH'ing in, running `claude login` on first connect, where the workspace and `~/.config/claude` live, using a private git repo with a deploy key, ACL recommendations (one device = one operator).
- Egress-firewall section: which control-plane hostnames are auto-allowed by the addon, and how to add a git-host egress entry when using a non-public repo host.

Reversibility: safe — docs only.

UI changes: none.

Schema changes: none.

Done when: the Claude Shell user-docs page is reachable from the in-app help index and a fresh operator can follow it end-to-end without reading source.

Verify in prod: docs page rendered in production in-app help; at least one operator confirms the page covered everything they needed to onboard.

## 6. Risks & open questions

- **Tailscale identity vs operator identity.** The container runs as one tailnet device; anyone with tailnet access to that device can SSH in. Per-operator gating depends on ACLs the customer's tailnet admin declares. We document the recommendation in Phase 7 but don't ship an ACL bootstrap.
- **`claude login` storage and upgrades.** Claude Code's OAuth flow writes credentials under `~/.config/claude/`. We persist `/home/claude` on a volume so re-creating the container doesn't re-prompt. Future Claude Code releases may move credential storage — entrypoint smoke tests should catch that early.
- **Image size and registry pressure.** Claude Code CLI plus `tailscaled` is likely in the ~500 MB range. Worth tracking GHCR storage and pull cadence after Phase 1 lands.
- **Update story for Claude Code itself.** When Anthropic ships a new `claude` release, we currently expect a Mini Infra image rebake + republish (operator pulls the new tag). Flag if early operator feedback wants in-container self-update instead.
- **Git-host egress derivation.** Phase 5 documents that operators must manually allow `github.com:22` / `github.com:443` / etc. in their env's egress policy when using a non-public repo host. Auto-deriving an egress rule from `GIT_REPO_URL` is plausible (parse host, emit a `requiredEgress` entry) but out of scope here — revisit if operators trip on it.
- **Pool-style multi-instance shells.** Out of scope by §3 — pool addon support is already in flight via MINI-48. If Claude Shell wants per-developer shells from a single pool definition later, the env-injection mode from Phase 2 should compose with the Phase 6 pool integration without further framework changes.

## 7. mk tracking

Tracked under the `claude-shell` feature in mk.

- MINI-_TBD_ — Phase 1: `claude-shell/` container image
- MINI-_TBD_ — Phase 2: Addon framework env-injection mode
- MINI-_TBD_ — Phase 3: `claude-shell` addon (server-side)  [blocks-by: 1, 2]
- MINI-_TBD_ — Phase 4: Connect-panel SSH URL for `claude-shell`  [blocks-by: 3]
- MINI-_TBD_ — Phase 5: Vault-stored git deploy key  [blocks-by: 1, 3]
- MINI-_TBD_ — Phase 6: Applications-page "Claude Shell" preset + create flow  [blocks-by: 4, 5]
- MINI-_TBD_ — Phase 7: Operator docs  [blocks-by: 6]
