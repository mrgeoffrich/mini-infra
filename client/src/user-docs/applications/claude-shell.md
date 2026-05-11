---
title: Claude Shell
description: How to create, connect to, and authenticate a Claude Shell — a Tailscale-SSH-reachable developer container with Claude Code pre-installed.
tags:
  - applications
  - claude-shell
  - tailscale
  - ssh
  - claude-code
  - vault
  - egress
---

# Claude Shell

A **Claude Shell** is a single-container developer environment with the Claude Code CLI pre-installed, reachable directly over Tailscale SSH. You create one from the Applications page, SSH in via your tailnet, run `claude login` once, and use it like any other Claude Code workspace — with the convenience that the container, volumes, and tailnet identity are all managed by Mini Infra.

It's aimed at operators who want a long-lived Claude Code sandbox without standing up their own VM, or who want to run Claude Code against a private repo on a host that isn't their laptop.

## Prerequisites

### Tailscale connected service

Claude Shell uses the same Tailscale OAuth client the `tailscale-ssh` and `tailscale-web` addons use to mint per-instance authkeys. If you haven't connected Mini Infra to your tailnet yet, follow the [Tailscale settings](/help/settings/tailscale) page first — you need:

- An OAuth client with `auth_keys` (write) and `devices:core` (write) scopes.
- `tag:mini-infra-managed` assigned to that OAuth client.
- The ACL bootstrap snippet from the Tailscale settings page pasted into your tailnet policy (it grants `ssh action: check` to managed devices — without it, SSH connections are rejected by ACL).

When the **Tailscale** connectivity card is green, the create form will let you submit.

### SSH deploy key (only for private git repos)

If you want the shell to clone a private repo into `/workspace` on first start, generate an ed25519 (or RSA) deploy key and add the **public** half to your git host as a repo-scoped deploy key. The **private** half is what you'll paste into the create form — it's sent straight to Vault and never stored on the Mini Infra host or echoed back from the API.

For public repos (HTTPS clone), no key is needed.

### ACL recommendation: one device = one operator

A Claude Shell registers as a single Tailscale device. Anyone with tailnet ACL access to that device can SSH into it and inherit whatever credentials `claude login` has stored in `/home/claude`. Mini Infra recommends treating each Claude Shell as belonging to one operator and gating access with a per-operator tag or grant in your tailnet policy. Mini Infra documents this recommendation but doesn't enforce it — ACL design is owned by your tailnet admin.

## Creating a Claude Shell

1. Open **Applications** → **New** and pick the **Claude Shell** tile.
2. Fill in the form:
   - **Name** — a human-readable name, e.g. `My Shell`. It's slugified to form the stack ID and the names of the two persistent volumes (`<slug>-workspace`, `<slug>-home`).
   - **Environment** — the target environment. Network type doesn't matter for SSH reachability since traffic rides on Tailscale.
   - **Git repo URL** (optional) — either an `https://` URL for a public repo or a `git@host:path` SSH URL for a private repo. Cloned into `/workspace` on first start only; subsequent restarts reuse the existing checkout.
   - **SSH deploy key** (optional, enabled once a git URL is filled) — paste the PEM body of the private deploy key. Sent to Vault at submit time, never stored in form state after submission.
   - **Extra tailnet tags** (advanced, optional) — comma-separated tags layered on top of the default `tag:mini-infra-managed`. Each tag must already exist in your tailnet's `tagOwners`.
3. Click **Create Claude Shell**. The form chains four API calls: create stack template → publish → instantiate → upload deploy key (if any) → apply.
4. Wait for the stack to reach **Synced** state on the application detail page. The image is ~600 MB (~158 MB compressed) so the first pull on a fresh host takes a moment.

Screenshot TBD — once a fresh dev env has been used to capture the Applications catalog tile, the create form, and the resulting stack detail page, they belong here.

## Connecting via SSH

Once the stack is healthy, open its detail page. The **Connect** panel shows a row for the Claude Shell addon with a copy-pastable SSH command of the form:

```
ssh root@<stack>-<service>-<env>.<tailnet>.ts.net
```

The hostname is derived from your stack name, the service name (`shell`), and the environment, all sanitised and joined with hyphens. Copy the command and paste it into your terminal — your local Tailscale client handles authentication via your tailnet identity, so there's no password prompt and no SSH key for you to manage on the connecting side.

First successful connect drops you at `/workspace` (which is empty unless you configured `gitRepo`, in which case it's the freshly cloned repo).

## Authenticating Claude Code on first connect

The image ships the Claude Code CLI but does **not** store Anthropic credentials — Mini Infra is deliberately out of that loop. On your first SSH session:

```bash
claude login
```

Follow the OAuth flow that Claude Code prints (it opens a browser tab; complete the login and return to the terminal). The resulting credentials are written to `~/.config/claude/` inside the container, which lives on the `/home/claude` persistent volume — so they survive container restarts, image updates, and stack re-applies.

If the `/home/claude` volume is deleted (e.g. you destroy the application and recreate it from scratch), you'll need to run `claude login` again. There's no way to migrate credentials between volumes from the Mini Infra side.

## Workspace and persistence

A Claude Shell has two named Docker volumes:

| Path | Volume name | What lives there |
|------|-------------|------------------|
| `/workspace` | `<slug>-workspace` | Cloned repo (if `gitRepo` configured) plus any files you edit. Persists across restarts. |
| `/home/claude` | `<slug>-home` | Shell history, `claude` config + OAuth credentials, anything you `npm install`, MCP server installs. |

Both volumes survive `docker restart`, `docker stop && docker start`, and Mini Infra stack re-applies. Deleting the application from Mini Infra **does** remove the underlying containers; the volumes follow the standard stack-teardown semantics for your environment.

## Using a private git repo (SSH deploy key)

The simplest path is to paste the deploy key into the create form — Mini Infra writes it to Vault before the first apply and the entrypoint picks it up on container start.

If you want to add, rotate, or remove a key after the fact, the API surface is:

```bash
# Upload or rotate (PEM body in privateKey)
PUT /api/stacks/:stackId/services/shell/git-deploy-key
Content-Type: application/json
Body: { "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n" }

# Check whether a key is set (returns { hasKey: boolean } — the key material is never returned)
GET  /api/stacks/:stackId/services/shell/git-deploy-key

# Remove
DELETE /api/stacks/:stackId/services/shell/git-deploy-key
```

All three routes require the same `stacks:write` permission you need to edit the stack itself.

**Important quirk:** `DELETE` removes the Vault entry but does **not** automatically re-apply the stack. The running container still has the old `GIT_SSH_KEY` env var until you trigger an apply (from the stack detail page or the API). If you want to be sure the key is gone from the live container, run an apply after the delete.

**Rotating** a key is the same as uploading — `PUT` overwrites the previous value. The next apply picks up the new key.

The key material is never returned by any endpoint. `GET` only tells you whether one is set.

## Tailscale identity and ACLs

Each Claude Shell registers as a single ephemeral tailnet device named after the `{stack}-{service}-{env}` triple (sanitised to fit Tailscale's 63-character hostname limit; oversized names fall back to an FNV-1a-32 hash). The device is created with `--ephemeral`, so when the container stops it auto-cleans from your tailnet.

Per-operator gating — who on your tailnet can actually SSH into the device — is your tailnet admin's call. The ACL bootstrap snippet from the [Tailscale settings page](/help/settings/tailscale) grants `ssh action: check` to all members for managed devices, with a 12-hour re-check window. Tighten it (e.g. restrict by user tag or group) if you want only one operator to be able to reach a given shell.

## Egress firewall

Claude Shell's `claude-shell` addon declares the Tailscale control-plane hostnames in `requiredEgress`. When you apply the stack into an environment that has the egress firewall enabled, the reconciler automatically opens outbound holes for:

- `controlplane.tailscale.com`
- `*.tailscale.com`
- `*.tailscale.io`

No manual policy edits needed for the SSH path to work.

**Git clones from non-public hosts are not auto-derived.** If you set `gitRepo` to a non-public git host (your own GitLab, an internal Gitea, etc.) and your environment has the egress firewall on, you must add the git host's egress entry to your environment's policy yourself. Common cases:

| Clone URL shape | Egress entry to add |
|-----------------|---------------------|
| `git@github.com:owner/repo.git` (SSH) | `github.com:22` |
| `https://github.com/owner/repo.git` (HTTPS) | `github.com:443` |
| Your own host | `<git-host>:22` (SSH) or `<git-host>:443` (HTTPS) |

The addon deliberately doesn't parse `GIT_REPO_URL` to auto-emit a `requiredEgress` entry — operators are better served seeing the egress requirement explicitly in their policy than having Mini Infra guess. See the planning doc's risks section for context.

## Limits and trade-offs

- **One operator per shell.** A Claude Shell is a single tailnet device — no pool support yet. If you need per-developer shells from a single definition, that's a future follow-up on the pool framework.
- **Mini Infra doesn't store Anthropic credentials.** They live on the `/home/claude` volume. Lose the volume, log in again.
- **Image size is ~600 MB (~158 MB compressed).** First pull on a fresh host takes a moment. Subsequent pulls are fast since the layers are cached.
- **Default image tag is `ghcr.io/mrgeoffrich/mini-infra-claude-shell:latest`.** It's pulled on every apply through your existing registry credentials.
- **Claude Code updates ride on image rebakes.** When Anthropic ships a new `claude` release, Mini Infra publishes a new Claude Shell image tag and you pick it up on the next apply. In-container `npm install -g @anthropic-ai/claude-code` from your SSH session works but won't survive a container recreate — install it via the image instead.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Stack apply fails with `Tailscale connected service required` | The Tailscale connectivity card isn't green — finish the four-step setup in [Tailscale settings](/help/settings/tailscale). |
| Container starts then exits non-zero with `tailnet registration did not complete within 30s` | Egress firewall is blocking the Tailscale control plane, or the OAuth client's tag doesn't match. Check the entrypoint logs on the stack detail page. |
| SSH command from the Connect panel returns `Connection refused` | Your local Tailscale client isn't connected, or the device hasn't finished registering yet — give it 10–30s after the stack flips to Synced. |
| `git clone` failed on first start (workspace empty even though `gitRepo` is set) | Either the deploy key isn't valid for that repo, the git host isn't in the env's egress allowlist, or the URL is wrong. SSH in and run `git clone <url>` manually — the error will be more useful than the entrypoint log. |
| `claude login` opens a browser but fails to return | Network from the container to Anthropic's OAuth callback isn't reachable. Check egress policy for `*.anthropic.com:443`. |
| Lost OAuth credentials after redeploy | The `/home/claude` volume was removed or recreated. Run `claude login` again. |
