# Claude Shell (`mini-infra-claude-shell`)

Standalone container image that bakes `tailscaled` + the Claude Code CLI + `git`
+ `tini` together so a developer can SSH directly into a Mini Infra-managed
container, authenticate Claude Code with `claude login`, and operate on a
persistent workspace volume.

This is the Phase 1 deliverable from
[`docs/planning/not-shipped/claude-shell-plan.md`](../docs/planning/not-shipped/claude-shell-plan.md).
Phases 2+ wire the image into the Service Addons framework, the Connect-panel
UI, and the Applications-page preset; the image itself stays a single-purpose
artefact runnable end-to-end with only Tailscale env vars supplied.

## Not in the pnpm workspace

This folder is standalone — same precedent as `update-sidecar/` and
`agent-sidecar/`. There's nothing to compile (the only deliverable is the
image), so `package.json` exists only to give the root `pnpm build:claude-shell`
script a uniform shape to invoke.

## Image contents

| Component | Source |
| --- | --- |
| `tailscaled` + `tailscale` | base image `tailscale/tailscale:stable` |
| `node`, `npm` | `apk add nodejs npm` |
| `claude` CLI | `npm install -g @anthropic-ai/claude-code` |
| `git`, `openssh-client` | `apk add git openssh-client` |
| `tini` | `apk add tini` — runs as PID 1 |
| `bash` | `apk add bash` — entrypoint uses bashisms |

`HOME=/home/claude`, `WORKDIR=/workspace`. Both are declared as `VOLUME`s so
the addon (Phase 3) and hand-crafted stacks get persistent mounts by default.

## Runtime env contract

See §4.4 of the plan. The entrypoint reads:

| Env var | Required | Effect |
| --- | --- | --- |
| `TS_AUTHKEY` | yes | tailscaled login key — fail if missing |
| `TS_HOSTNAME` | yes | `tailscale up --hostname` — fail if missing |
| `TS_EXTRA_ARGS` | yes | extra args to `tailscale up`; today always `--ssh` |
| `GIT_REPO_URL` | no | first-start workspace clone |
| `GIT_SSH_KEY` | no | SSH deploy key for the clone; written to `$HOME/.ssh/id_ed25519` mode 600 |
| `WORKSPACE_DIR` | no | clone target; defaults to `/workspace` |

The entrypoint:

1. Validates required env (clear non-zero exit if anything is missing).
2. If `GIT_SSH_KEY` is set, writes it to `$HOME/.ssh/id_ed25519` (mode 600)
   and best-effort seeds `known_hosts` for github.com / gitlab.com /
   bitbucket.org.
3. If `GIT_REPO_URL` is set *and* `WORKSPACE_DIR` is empty, clones the repo.
   Clone failures are logged but do not fail the container — the operator
   should still be able to SSH in and diagnose.
4. Starts `tailscaled --statedir=/var/lib/tailscale` in the background.
5. Runs `tailscale up --authkey=… --hostname=… $TS_EXTRA_ARGS` (intentionally
   unquoted so `--ssh` parses as its own arg).
6. Polls `tailscale status --json` for `Self.Online == true` for up to 30s,
   exiting non-zero with a clear message if registration never completes —
   surfaces firewall / control-plane reachability problems fast.
7. `wait`s on the tailscaled PID so the container stays up under tini and
   exits cleanly if tailscaled dies.

## Building locally

From the repo root:

```bash
pnpm build:claude-shell           # runs the (no-op) npm build script
docker build -t claude-shell-local claude-shell/
```

## Smoke testing locally

```bash
# Validation: container should exit non-zero with a clear missing-env message.
docker run --rm claude-shell-local

# Validation: with bad creds, should fail at `tailscale up` within ~30s, not hang.
docker run --rm \
  -e TS_AUTHKEY=invalid \
  -e TS_HOSTNAME=test \
  -e TS_EXTRA_ARGS=--ssh \
  claude-shell-local
```

End-to-end smoke (registers a real device — needs a valid ephemeral authkey):

```bash
docker run --rm \
  -e TS_AUTHKEY=tskey-auth-... \
  -e TS_HOSTNAME=my-claude-shell \
  -e TS_EXTRA_ARGS=--ssh \
  claude-shell-local
# Then from a tailnet peer: ssh root@my-claude-shell.<tailnet>
# Inside: claude --version, claude login
```

## Publishing

Built and pushed by `.github/workflows/docker-build.yml` alongside the
sidecars + egress images. Image is tagged on the same matrix as the rest of
the platform (`:main-<sha>`, `:dev`, `:production`, semver tags):

```
ghcr.io/<repo>-claude-shell:<tag>
```

## Out of scope for this phase

- Anthropic credential brokering — see plan §3. Users run `claude login`
  interactively in their SSH session; tokens persist on the `/home/claude`
  volume.
- Bundled MCP server installs — users install MCP servers inside their
  workspace if they want them.
- Auto-derived git-host egress rules — operators declare any non-Tailscale
  egress (e.g. `github.com:22`) in their env's egress policy. Tracked under
  Phase 5 in the plan.
