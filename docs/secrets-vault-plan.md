# SecretsVault — OpenBao as a managed service

Mini Infra hosts OpenBao the same way a cloud platform hosts a managed secrets service. Applications deployed through Mini Infra log in via short-lived AppRole credentials minted at deploy time; operators manage Vault policies as HCL files stored in Mini Infra. Mini Infra itself **does not** depend on Vault — it writes to Vault but never reads its own secrets from it, so a sealed or broken Vault does not break the platform.

Inspired by the two-stage bootstrap/up pattern in `slackbot-agent-sdk/environment/` ([`bootstrap.ts`](https://github.com/geoff-rich/slackbot-agent-sdk/blob/main/environment/vault/bootstrap.ts), [`up.ts`](https://github.com/geoff-rich/slackbot-agent-sdk/blob/main/environment/up.ts)), generalised and absorbed into Mini Infra's existing Stack + Configuration machinery.

## Related documents

- [secrets-vault-implementation.md](secrets-vault-implementation.md) — concrete, phase-by-phase implementation plan with file paths, schema changes, and services to add.

## Out of scope (tracked separately)

- OIDC / JWT federation so operators can open the Vault UI as themselves — see [vault-oidc-plan.md](vault-oidc-plan.md).
- Docker volume → Azure Blob backups (useful for backing up the vault's data volume) — see [volume-azure-backup-plan.md](volume-azure-backup-plan.md).

MVP uses OpenBao's built-in userpass/root/AppRole flows. Operators log into the Vault UI with credentials minted by Mini Infra (short-lived, userpass-backed). OIDC lands later.

## Concepts & data model

### New resources

- **SecretsVault** — a singleton record representing the managed OpenBao instance. Fields: `status` (Uninitialised / Sealed / Unsealed / Error), `address`, `stackId` (→ the underlying Stack), `initialisedAt`, `lastUnsealedAt`. One per Mini Infra install (for now).
- **VaultState** — encrypted persistent state: unseal key shares (wrapped), root token (rotated after bootstrap), mini-infra admin AppRole role_id/secret_id. Separate table so the row can be excluded from routine backups with different retention rules.
- **VaultPolicy** — `{ name, hclBody, publishedVersion, draftVersion, publishedAt }`. Versioned with draft/publish semantics mirroring `StackTemplate`.
- **VaultAppRole** — `{ name, policyName, secretIdNumUses, tokenPeriod, tokenTtl, tokenMaxTtl }`. Configuration for an AppRole; Mini Infra reconciles these against Vault on change.
- **StackVaultBinding** — extension to `Stack` (or `Application`): `{ appRoleName, injectAs: 'env' | 'file' }`. Opt-in. When set, the stack apply flow injects a wrapped secret_id for that AppRole at deploy time.

### Concepts reused

- Stack + Stack Template — the OpenBao service itself is a system stack template.
- `ConfigurationServiceFactory` — new `vault` category exposing status + address.
- Task tracker — bootstrap, unseal, policy apply, role apply all use the existing long-running-op pattern.
- Socket.IO channels — new `Channel.VAULT` with `VAULT_BOOTSTRAP_*`, `VAULT_UNSEAL_*`, `VAULT_POLICY_APPLIED`, `VAULT_ROLE_APPLIED` events.

## Operator passphrase — the unseal story

Mini Infra must not auto-unseal Vault with secrets it can decrypt unattended; that would defeat Shamir. Instead:

- On Mini Infra boot, prompt the operator once for a **passphrase** (CLI prompt, env var, or one-time UI entry that stays in memory only).
- The passphrase derives (Argon2id) a key-wrapping key. Unseal shares and the mini-infra-admin secret_id are stored in `VaultState` **wrapped by that key** — cannot be decrypted without the passphrase.
- With the passphrase in memory, Mini Infra auto-unseals on Vault restart, rotates credentials, and mints secret_ids transparently.
- Without it (e.g. fresh Mini Infra restart), Vault stays sealed; the UI shows a banner "Operator passphrase required to unseal Vault" with a one-time input. Mini Infra **keeps running** — only Vault-dependent features degrade.
- Passphrase never touches disk, never leaves the server process. Changing it re-wraps the state.

Tradeoffs vs pure auto-unseal: operator must re-enter the passphrase after Mini Infra restarts. That's the cost of not making Mini Infra a single point of compromise.

## Bootstrap flow (first-time setup)

Equivalent of `bootstrap.ts`. Runs once when the operator deploys the SecretsVault stack.

1. Deploy the OpenBao stack via the normal stack apply pipeline (system template).
2. Wait for `/v1/sys/health` to respond.
3. Call `sys/init` with `secret_shares: 3, secret_threshold: 2`. Capture unseal keys + root token.
4. Wrap unseal keys + root token with the operator passphrase's key-wrapping key. Persist to `VaultState`.
5. Unseal using 2 of 3 shares.
6. Enable auth methods: `approle/`, `userpass/`.
7. Enable `kv/` v2 at `secret/`.
8. Write the built-in `mini-infra-admin` policy and create a matching AppRole. Capture its role_id + secret_id, wrap with the operator key, persist.
9. Rotate the root token (generate a new one, revoke the original). From now on Mini Infra uses the admin AppRole for all Vault operations; root only regenerated via a manual rotation ceremony.
10. Emit `VAULT_BOOTSTRAP_COMPLETED`. Show the operator a one-time banner: "Download unseal keys" — the operator gets a copy in case Mini Infra state is lost.

All of this is a single long-running op tracked via the task tracker, step by step.

## HCL policy management

No permissions UI — the HCL *is* the interface. Follows the Stack Template draft/publish pattern.

- **List page** — all policies with publish status + last-applied-to-Vault timestamp.
- **Editor** — Monaco with HCL syntax highlighting (existing Monaco setup in the client; add HCL mode). Shows diff between draft and published.
- **Publish action** — validates HCL locally (basic lint), writes to Vault via `PUT sys/policies/acl/<name>`, marks version as published.
- **Delete action** — removes from Vault + DB; warns if any AppRole references it.
- **Import** — seed canonical policies (analogue of `slack-gateway-secrets.hcl`, `user-self-service.hcl` etc.) as system policies on first boot. Operators can copy/edit them.

AppRoles are managed the same way: small form with policy picker + TTL fields, or paste raw JSON for the role definition. Reconciled against Vault on change.

## Per-deploy secret_id injection (the `up.ts` equivalent)

This is where the feature earns its keep. Slots into the existing stack apply pipeline.

When a stack has a `StackVaultBinding`, the apply executor:

1. Reads `role_id` from Vault (`GET auth/approle/role/<name>/role-id`) — cached per-role, durable.
2. Mints a **response-wrapped** secret_id via `POST auth/approle/role/<name>/secret-id` with header `X-Vault-Wrap-TTL: 60s`.
3. Injects two env vars into every container in the stack:
   - `VAULT_ADDR` = the internal Vault address (e.g. `http://navi-vault:8200`)
   - `VAULT_ROLE_ID` = role_id
   - `VAULT_WRAPPED_SECRET_ID` = wrapping token (60s TTL)
4. Containers unwrap at boot via `sys/wrapping/unwrap`, then log in via `auth/approle/login`. After that they renew periodically based on the policy.

Wrapped secret_ids never land in logs, env files, or long-lived config — they're minted per deploy and die 60s after the apply. A failed apply leaves nothing behind.

## Networking — who reaches Vault and how

Three audiences, three paths. Mini Infra already owns HAProxy, ACME-issued TLS, and Cloudflare tunnels — lean on those rather than inventing new exposure patterns.

### 1. Container-to-container (apps on the host)

Dedicated external Docker network: `mini-infra-vault-net`. The Vault stack declares it as its primary network (external, so the lifecycle is independent of the Vault stack).

Any stack with a `StackVaultBinding` is automatically attached to `mini-infra-vault-net` at apply time, alongside its normal environment network. Those containers reach Vault at `http://mini-infra-vault:8200`. Stacks without a binding never touch the network and cannot see Vault.

No TLS inside this overlay — the wrapped-secret_id handshake already protects the credential exchange, and everything is on the same Docker host. Adding internal TLS is a bigger lift than it's worth for MVP.

### 2. Users on the local network / LAN

Vault UI is exposed as a first-class application in HAProxy. Reuse the `StatelessWeb` service type with a Shared frontend route (e.g. `vault.<local-domain>`). TLS terminates at HAProxy using the existing ACME cert machinery — no special case. Vault's own auth (userpass for MVP, OIDC later per [vault-oidc-plan.md](vault-oidc-plan.md)) handles identity.

This is identical to how any other internal app is published — Vault is just an app that happens to be system-managed.

### 3. Remote users (optional)

If the install has an internet-type environment with a Cloudflare tunnel, an operator can opt in to a tunnel route pointing at the HAProxy frontend above. Inherits all the existing tunnel plumbing. Recommended to gate behind Cloudflare Access when enabled. Off by default — most single-host installs won't need it.

### Mini Infra → Vault (server-side admin calls)

Two viable options:
- **Put the Mini Infra server container on `mini-infra-vault-net`** — cleanest. Same address as apps use (`http://mini-infra-vault:8200`). Slightly increases Mini Infra's attack surface (it now sits on the Vault network).
- **Bind `127.0.0.1:8200` on the Vault container** — for installs where Mini Infra runs on the host, not in Docker, or where the operator wants Mini Infra off the Vault network. Host-local only, not user-facing.

Pick the Docker-network option as the default; expose `127.0.0.1:8200` only when explicitly toggled.

### Explicitly rejected

- **Host port binding as the primary path** — duplicates HAProxy's job, doesn't scale past a single laptop, and forces operators to think about firewall rules Mini Infra could handle for them.
- **Tailscale sidecar** (the slackbot-agent-sdk pattern) — introduces a non-native dependency and duplicates what HAProxy + Cloudflare tunnels already provide. Operators who want tailnet access can still run their own tailnet sidecar out-of-band.
- **Per-environment Vault reverse proxies** — deferred. Single shared network is enough for one Docker host. The schema doesn't preclude it later.

### Tradeoffs

- **Shared Vault network** — any compromised app container on `mini-infra-vault-net` can at least reach the Vault API. It still needs a valid token, AppRole policies are strict, and Vault's audit log catches misuse. Kubernetes-style network policies would be stricter; out of scope.
- **HAProxy as the Vault UI fronting** — if HAProxy is down, the UI is down. HAProxy is already platform-critical, so not a new failure mode. Operators can still hit the API directly on the Vault network if they need break-glass access.

## Mini Infra's own Vault usage

Deliberately minimal in MVP:
- Mini Infra uses the admin AppRole only for policy management, role management, and secret_id minting.
- Mini Infra does **not** store its own operational secrets in Vault (API keys, registry creds, Azure connection strings continue to use the existing encrypted-at-rest DB pattern). This keeps the platform bootable when Vault is sealed, broken, or mid-upgrade.
- Later: optional migration path where platform secrets can be sourced from Vault, but always with a local-DB fallback.

## Build plan — rough phases

1. **OpenBao stack template** — system template + one-click deploy via existing stack machinery. UI shows Vault status on a new "Secrets" page.
2. **Bootstrap flow** — init + unseal + root rotation + admin AppRole, wrapped by operator passphrase. Task-tracker integration.
3. **Policy CRUD + HCL editor** — list, edit, publish, delete. Monaco HCL mode.
4. **AppRole CRUD** — small form, reconciled against Vault on change.
5. **Stack Vault binding** — schema field + apply-time secret_id injection. Ship one reference app template (e.g. a "Hello Vault" container) that unwraps and reads a secret.
6. **Auto-unseal on Vault restart** — Mini Infra health-checks Vault and unseals when sealed, provided the operator passphrase is in memory.
7. **Recovery flows** — operator-initiated root rotation; "paste unseal keys" flow for disaster recovery when `VaultState` is lost.

## Risks & open questions

- **Operator UX for the passphrase** — how prominent is the banner when Vault is sealed? Should Mini Infra prompt at login if the passphrase isn't cached? Needs a small design pass.
- **Multiple Vaults per install** — today we assume one. Environments might want isolation. Deferred; the schema allows it without rework if the `SecretsVault` row grows an `environmentId`.
- **Policy linting** — local HCL validation is nice-to-have; worst case we surface Vault's error on publish.
- **Backup of `VaultState`** — must be part of Mini Infra's own DB backup. The *vault data volume* backup is covered by the separate volume-backup plan.
- **Sidecar pattern for AppRole** — apps that can't be modified to unwrap at boot need a helper. Possible future: an optional `vault-agent` sidecar in the Stack definition that unwraps + renders templates into a shared volume. Out of scope for MVP.
- **Audit logging** — OpenBao has its own audit log; expose it in the Mini Infra UI? Probably later, once the core flows are solid.
