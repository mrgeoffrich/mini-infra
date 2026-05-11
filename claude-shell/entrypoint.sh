#!/bin/bash
# Entrypoint for the Mini Infra Claude Shell container.
#
# Implements the env contract from docs/planning/not-shipped/claude-shell-plan.md §4.4:
#   - Required: TS_AUTHKEY, TS_HOSTNAME, TS_EXTRA_ARGS
#   - Optional: GIT_REPO_URL, GIT_SSH_KEY, WORKSPACE_DIR (default /workspace)
#
# Boots tailscaled in the background, waits for the device to register on the
# tailnet, optionally seeds an SSH deploy key + clones a workspace repo, then
# `wait`s on tailscaled so the container stays up under tini and exits cleanly
# if tailscaled dies.
set -euo pipefail

log() {
  printf '[claude-shell] %s\n' "$*" >&2
}

die() {
  printf '[claude-shell][fatal] %s\n' "$*" >&2
  exit 1
}

# ---- Required env validation -------------------------------------------------
missing=()
[[ -z "${TS_AUTHKEY:-}" ]] && missing+=("TS_AUTHKEY")
[[ -z "${TS_HOSTNAME:-}" ]] && missing+=("TS_HOSTNAME")
# TS_EXTRA_ARGS must be *set* (even if empty would be valid for tailscale up,
# the addon always sets it to `--ssh` today — treat unset as misconfiguration
# so silently-no-SSH never ships).
if [[ -z "${TS_EXTRA_ARGS+x}" ]]; then
  missing+=("TS_EXTRA_ARGS")
fi
if (( ${#missing[@]} > 0 )); then
  die "missing required env vars: ${missing[*]}"
fi

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
SSH_DIR="${HOME:-/home/claude}/.ssh"

# ---- Optional: write SSH deploy key + known_hosts ---------------------------
if [[ -n "${GIT_SSH_KEY:-}" ]]; then
  log "writing git SSH deploy key to ${SSH_DIR}/id_ed25519"
  mkdir -p "${SSH_DIR}"
  chmod 700 "${SSH_DIR}"
  # printf preserves an explicit trailing newline if the key was supplied
  # without one — OpenSSH requires it.
  printf '%s\n' "${GIT_SSH_KEY}" > "${SSH_DIR}/id_ed25519"
  chmod 600 "${SSH_DIR}/id_ed25519"
  # Best-effort known_hosts seeding for the common public git hosts; we keep
  # going even if a host doesn't respond, because the container should still
  # come up so the user can SSH in and debug.
  log "seeding known_hosts for common git hosts (best-effort)"
  ssh-keyscan -T 5 -t ed25519,rsa github.com gitlab.com bitbucket.org \
      >> "${SSH_DIR}/known_hosts" 2>/dev/null || \
    log "ssh-keyscan returned non-zero — continuing"
  chmod 600 "${SSH_DIR}/known_hosts" 2>/dev/null || true
fi

# ---- Optional: clone workspace repo on first start --------------------------
if [[ -n "${GIT_REPO_URL:-}" ]]; then
  mkdir -p "${WORKSPACE_DIR}"
  # "Empty" = no entries other than `.` / `..`. We don't want to clobber an
  # existing checkout that the user has edited, and we don't want a hidden
  # `.git` directory left from a half-clone to silently re-clone.
  if [[ -z "$(ls -A "${WORKSPACE_DIR}" 2>/dev/null)" ]]; then
    log "cloning ${GIT_REPO_URL} into ${WORKSPACE_DIR}"
    if ! git clone "${GIT_REPO_URL}" "${WORKSPACE_DIR}"; then
      # Don't fail the container — operator should still be able to SSH in
      # and debug (bad URL, missing key, host not in known_hosts, etc.).
      log "git clone failed — leaving workspace empty so you can SSH in and debug"
    fi
  else
    log "workspace ${WORKSPACE_DIR} is non-empty; skipping clone"
  fi
fi

# ---- Start tailscaled -------------------------------------------------------
mkdir -p /var/lib/tailscale
log "starting tailscaled (statedir=/var/lib/tailscale)"
tailscaled --statedir=/var/lib/tailscale &
TAILSCALED_PID=$!

# tailscaled needs a moment before `tailscale up` can talk to its local API.
# Poll the socket rather than sleeping a fixed interval.
for _ in $(seq 1 20); do
  if tailscale status >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# ---- tailscale up (auth + hostname) -----------------------------------------
# TS_EXTRA_ARGS is intentionally *not* quoted — it's an arg list (e.g. `--ssh`).
log "running: tailscale up --authkey=*** --hostname=${TS_HOSTNAME} ${TS_EXTRA_ARGS}"
# shellcheck disable=SC2086
if ! tailscale up --authkey="${TS_AUTHKEY}" --hostname="${TS_HOSTNAME}" ${TS_EXTRA_ARGS}; then
  die "tailscale up failed — check authkey validity and control-plane egress (login.tailscale.com:443)"
fi

# ---- Wait for tailnet registration ------------------------------------------
# Poll `tailscale status --json` for Self.Online == true up to 30s. This is the
# fast-fail surface §5 calls out — if the control plane is unreachable in a
# firewalled env, we want the container to exit non-zero with a clear message
# rather than hanging indefinitely.
log "waiting for tailnet registration (up to 30s)"
registered=0
for _ in $(seq 1 30); do
  status_json="$(tailscale status --json 2>/dev/null || true)"
  if [[ -n "${status_json}" ]] && \
     printf '%s' "${status_json}" | grep -q '"Online": *true'; then
    registered=1
    break
  fi
  sleep 1
done
if (( registered == 0 )); then
  die "tailnet registration did not complete within 30s — check control-plane reachability and authkey scope"
fi

log "tailnet registration complete; hostname=${TS_HOSTNAME}"
log "container is up — SSH in via your tailnet to start a Claude Code session"

# ---- Block on tailscaled ----------------------------------------------------
# Exits with tailscaled's status so docker sees a clean stop when tailscaled
# is signalled by tini.
wait "${TAILSCALED_PID}"
