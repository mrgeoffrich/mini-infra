# Worktree dev — WSL2 driver for Windows hosts

Adds a second VM driver for `worktree_start` so the per-worktree dev flow runs on Windows. macOS keeps using Colima; Windows uses one Alpine WSL2 distro per worktree as the dockerd carrier. Linux is left as-is for now (existing flow assumes a remote Docker host or system dockerd).

## Goal

`pnpm dlx tsx deployment/development/worktree-start.ts --description "..."` on a Windows host produces the same end state as it does on macOS today:

- One isolated dockerd per worktree
- A registered entry in `~/.mini-infra/worktrees.yaml` with stable ports
- A healthy mini-infra at `http://localhost:<ui_port>`
- A seeded `environment-details.xml` at the worktree root
- `worktree_list` and cleanup work the same way

The bash wrappers (`worktree_start.sh`, `worktree_list.sh`) keep working on macOS unchanged. New `.cmd` siblings handle Windows.

## Why Option B (per-worktree WSL2 distro)

Rejected during exploration: dropping per-worktree isolation in favour of one shared Docker Desktop / Rancher Desktop daemon. That works but loses the "one stuck container can't blast-radius into other worktrees" property that the colima-per-worktree model gives today. With Alpine WSL2 distros being ~250 MB on disk and ~60 MB idle RAM each, the per-worktree model is cheap enough on Windows that there's no good reason not to keep it.

## Architecture mapping

| Colima concept | WSL2 equivalent |
|---|---|
| `colima start <profile>` | `wsl --import mini-infra-<profile> <install-dir> <base.tar>` |
| `colima status <profile>` | `wsl -l -v` parsed |
| `colima delete <profile> --data --force` | `wsl --unregister mini-infra-<profile>` |
| `~/.colima/<profile>/docker.sock` (host-side socket) | dockerd in distro on `tcp://0.0.0.0:<docker_port>` + `unix:///var/run/docker.sock` |
| `DOCKER_HOST=unix://...sock` | `DOCKER_HOST=tcp://localhost:<docker_port>` (WSL2 localhostForwarding) |
| Per-VM CPU/RAM (`--cpu 2 --memory 8`) | Global `.wslconfig` (shared pool — see Tradeoffs) |

## What stays unchanged

- [docker-compose.worktree.yaml](../../../deployment/development/docker-compose.worktree.yaml) — no source bind-mounts, only managed volumes + `/var/run/docker.sock`. Daemon-agnostic.
- [lib/seeder.ts](../../../deployment/development/lib/seeder.ts) — pure HTTP against `localhost:<ui_port>`. Verified portable: only `dgram`, `fetch`, `fs.readFileSync` for `dev.env`. The `dockerHost: 'unix:///var/run/docker.sock'` POSTed at line 218 is the *container's* view of the bind-mounted socket — works as long as dockerd in the distro listens on the unix socket (it will).
- [lib/registry.ts](../../../deployment/development/lib/registry.ts) — port-slot allocation logic. Extended (not rewritten) to cover `docker_port`.
- [lib/dev-env.ts](../../../deployment/development/lib/dev-env.ts), [lib/api.ts](../../../deployment/development/lib/api.ts), [lib/env-details.ts](../../../deployment/development/lib/env-details.ts) — pure file/HTTP, no platform assumptions.

## What changes

### Phase 1 — Alpine WSL2 base tarball pipeline

**Deliverable:** `scripts/build-wsl-base.ps1` that produces `~\.mini-infra\wsl-base.tar` (~250 MB).

Steps the script performs:

1. Download Alpine Mini Root Filesystem (`alpine-minirootfs-3.x-x86_64.tar.gz`, ~3 MB) from `https://dl-cdn.alpinelinux.org/alpine/v3.x/releases/x86_64/`. Hash-verify against the published checksum.
2. `wsl --import mini-infra-builder <temp-dir> <minirootfs.tar.gz>`.
3. Inside the builder distro, run an inline provisioning script:
   - `apk add --no-cache docker iptables ip6tables ca-certificates`
   - **iptables-legacy symlink** — Alpine 3.18+ defaults to nf_tables. dockerd needs `iptables-legacy` available; create the symlinks: `update-alternatives` or direct `ln -sf /usr/sbin/iptables-legacy /usr/sbin/iptables`. (Bake into base so per-worktree imports don't repeat.)
   - Drop in `/etc/mini-infra/start-dockerd.sh`:
     ```sh
     #!/bin/sh
     set -e
     PORT="${1:?docker port required}"
     mkdir -p /var/run /var/log/mini-infra
     # Idempotent: skip if already up
     if pgrep -x dockerd >/dev/null; then exit 0; fi
     nohup dockerd \
       -H tcp://0.0.0.0:"$PORT" \
       -H unix:///var/run/docker.sock \
       --iptables=true \
       >/var/log/mini-infra/dockerd.log 2>&1 &
     ```
     Made executable.
   - Add a probe helper `/etc/mini-infra/dockerd-ready.sh` that returns 0 once `docker info` succeeds against the unix socket.
4. `wsl --export mini-infra-builder <output-tar>`.
5. `wsl --unregister mini-infra-builder`.

Re-run any time we want to bump Alpine or dockerd versions. Checked-in `scripts/build-wsl-base.ps1` is the source of truth.

**Acceptance:** running `scripts/build-wsl-base.ps1` on a fresh Windows box produces a tarball; `wsl --import test ... <tarball>` + `wsl -d test -- /etc/mini-infra/start-dockerd.sh 2500` + `docker -H tcp://localhost:2500 info` succeeds.

### Phase 2 — `lib/wsl.ts` driver

**Deliverable:** new file mirroring [lib/colima.ts](../../../deployment/development/lib/colima.ts) contract.

Public surface:

```ts
export function isDistroRunning(name: string): boolean;
export function distroExists(name: string): boolean;
export interface WslImportOpts { name: string; baseTarball: string; installDir: string; }
export function importDistro(opts: WslImportOpts): void;
export function unregisterDistro(name: string): boolean;
export interface WslStartOpts { name: string; dockerPort: number; }
export function startDocker(opts: WslStartOpts): void;  // calls /etc/mini-infra/start-dockerd.sh
export function ensureDockerReady(name: string, dockerPort: number, attempts: number): Promise<boolean>;
```

All shell-out via `spawnSync('wsl', [...args])`. Distro names are `mini-infra-<profile>` to namespace and avoid collision with user-installed distros.

**Acceptance:** unit-style scripts in `deployment/development/lib/__tests__/wsl.test.ts` covering the parsing of `wsl -l -v` output. Integration coverage falls under Phase 8.

### Phase 3 — `lib/registry.ts` extension

**Deliverable:** add `docker_port` to `WorktreeEntry`, port range `2500–2599`, slot-aligned with the existing `ui_port`/`registry_port`/`vault_port` triple.

Changes:

- New constants: `DOCKER_PORT_MIN = 2500`, `DOCKER_PORT_MAX = 2599`.
- `WorktreeEntry.docker_port: number`.
- `allocatePorts(profile)` returns `{ ui_port, registry_port, vault_port, docker_port }`. Slot indexing already exists; add docker to the same slot.
- `migrateFromJsonIfNeeded` and existing entries: if `docker_port` is missing, fill it from the slot index of `ui_port`.

Backwards-compatible: macOS users with existing `worktrees.yaml` get `docker_port` populated on next run but never used (Colima driver ignores it).

### Phase 4 — Driver abstraction in `worktree-start.ts`

**Deliverable:** swap the colima block at [worktree-start.ts:260-273](../../../deployment/development/worktree-start.ts:260) for a driver dispatch.

Sketch:

```ts
type Driver = 'colima' | 'wsl';

function pickDriver(): Driver {
  if (process.env.MINI_INFRA_DRIVER === 'colima' || process.env.MINI_INFRA_DRIVER === 'wsl') {
    return process.env.MINI_INFRA_DRIVER;
  }
  return process.platform === 'darwin' ? 'colima' : 'wsl';
}

interface DriverHandle { dockerHost: string; }

async function ensureDriver(driver: Driver, profile: string, ports: PortAllocation): Promise<DriverHandle> {
  if (driver === 'colima') { /* existing logic */ }
  if (driver === 'wsl') {
    const distro = `mini-infra-${profile}`;
    if (!distroExists(distro)) {
      const baseTar = path.join(MINI_INFRA_HOME, 'wsl-base.tar');
      if (!fs.existsSync(baseTar)) throw new Error('Run scripts/build-wsl-base.ps1 first');
      importDistro({ name: distro, baseTarball: baseTar, installDir: path.join(MINI_INFRA_HOME, 'wsl', profile) });
    }
    if (!isDistroRunning(distro)) startDocker({ name: distro, dockerPort: ports.docker_port });
    const ok = await ensureDockerReady(distro, ports.docker_port, 30);
    if (!ok) throw new Error('dockerd did not come up in WSL distro');
    return { dockerHost: `tcp://localhost:${ports.docker_port}` };
  }
}
```

Prereq check at [worktree-start.ts:174-179](../../../deployment/development/worktree-start.ts:174) becomes driver-aware: `colima` only required when driver is `colima`; `wsl` only required when driver is `wsl`. `docker` is always required (it's the Windows-side CLI talking to whichever daemon).

The `dockerSockPath` existence check at [worktree-start.ts:268-272](../../../deployment/development/worktree-start.ts:268) becomes a `dockerHost` reachability probe (already covered by `ensureDockerReady`).

The `colima_vm` field on `WorktreeEntry` is repurposed to "VM identifier" — for WSL it stores the distro name. Not renaming yet to keep diffs small; add a one-line comment.

### Phase 5 — Windows entrypoints

**Deliverable:** three `.cmd` files matching the existing `.sh` files.

```
deployment/development/worktree_start.cmd
deployment/development/worktree_list.cmd
deployment/development/worktree_cleanup.cmd
```

Each is one line, e.g.:

```cmd
@echo off
pushd "%~dp0..\.."
pnpm dlx tsx@^4.21.0 deployment\development\worktree-start.ts %*
popd
```

The `.sh` versions stay for macOS users.

CLAUDE.md gets a sentence: "On Windows, use `deployment\development\worktree_start.cmd`".

### Phase 6 — Cleanup parity

**Deliverable:** [worktree-cleanup.ts](../../../deployment/development/worktree-cleanup.ts) updated to dispatch on driver.

When tearing down a worktree:

- macOS: `colima delete <profile> --data --force` (existing).
- Windows: `wsl --unregister mini-infra-<profile>` (drops the VHDX, equivalent of `--data --force`).

The orphan-detection logic (worktree directory gone but registry entry remains) becomes driver-aware too.

`worktree_cleanup.plist` (macOS launchd) has no Windows analog. Adding a Task Scheduler equivalent is out of scope — Windows users run cleanup manually.

### Phase 7 — Documentation

**Deliverables:**

- [CLAUDE.md](../../../CLAUDE.md) — update the Worktree Development Workflow section with a Windows note: "On Windows, run `worktree_start.cmd` instead of `worktree_start.sh`. First-time setup also requires `scripts\build-wsl-base.ps1`."
- New `docs/user/wsl2-reference.md` mirroring [docs/user/colima-reference.md](../../../docs/user/colima-reference.md). Cover: prereqs (`wsl --install`), base tarball build, listing distros (`wsl -l -v`), inspecting (`wsl -d <name>`), nuking, `.wslconfig` global memory cap, the `localhostForwarding` requirement.
- README mention if there is one.

### Phase 8 — Test passes on real Windows hardware

Cannot be done in CI today — needs a Windows box with WSL2 enabled. Manual checklist:

1. **Cold-start.** Fresh box, no `~\.mini-infra\`, no distros. Run `scripts\build-wsl-base.ps1` then `worktree_start.cmd --description "test"`. Expect: tarball produced, distro imported, dockerd up, registry container, mini-infra image built and pushed, app healthy, seeder runs, `environment-details.xml` written.
2. **Second worktree.** From a second worktree path, `worktree_start.cmd --description "test 2"`. Expect: distinct slot allocated (e.g. 3101 / 5101 / 8201 / 2501), no port collision, both UIs reachable.
3. **`--reset` path.** Wipes volumes, keeps distro, re-seeds.
4. **Re-run idempotency.** Re-run with no flags; existing distro reused, image rebuilt, no re-seed.
5. **`worktree_list.cmd`.** Lists both entries.
6. **Cleanup.** `worktree_cleanup.cmd` removes a deleted worktree's distro and registry entry.
7. **Cross-driver coexistence.** macOS user with existing `worktrees.yaml` from before this change: `docker_port` backfilled, no behavioural change.

## Tradeoffs

1. **Global memory budget.** `.wslconfig` controls RAM/CPU for *all* WSL distros combined. Can't say "worktree A gets 8 GB, B gets 4 GB" the way Colima does. For 1–3 concurrent worktrees the dynamic shared pool is actually friendlier than colima's static per-VM cap; for heavy users with many worktrees we document the `[wsl2] memory=16GB` knob.
2. **Build context streaming over loopback TCP.** `docker.exe` on Windows tars `PROJECT_ROOT` and streams to dockerd in WSL. Loopback throughput is high enough that a few-hundred-MB context is fine, but a multi-GB context will be noticeably slower than the macOS virtiofs mount. Mitigation: existing `.dockerignore` is already tight.
3. **TCP dockerd is unauthenticated.** Bound to `0.0.0.0` *inside the distro* (not on the LAN), and Windows' `localhostForwarding` exposes it only on `127.0.0.1`. For a single-user dev box, fine. Multi-user Windows boxes should disable port forwarding or add TLS — out of scope.
4. **No systemd in the distro.** dockerd runs under `nohup`. Distro shutdown (`wsl --shutdown`) kills it cleanly; on next `wsl -d` the start script re-launches. Lifecycle is more "one-shot script" than "service manager"; that's fine for our use.
5. **`docker.exe` is a separate prereq on Windows.** Users need the Docker CLI on PATH. We can ship instructions to install just the static binary from `https://download.docker.com/win/static/stable/` (~50 MB) — no Docker Desktop subscription required.

## Open questions

- **Should we also support Linux hosts?** Today the script assumes macOS via colima. Linux users are presumably running their own dockerd already and could use a third driver (`local-daemon`, no VM). Out of scope here, but the `pickDriver()` function leaves room for it.
- **Cleanup timer on Windows.** The macOS launchd job runs `worktree_cleanup.sh` periodically. Should we add a Task Scheduler analog, or leave it as a manual command?
- **`--cpu` / `--memory` flags.** Currently hardcoded to 2 CPU / 8 GB for colima. WSL2 driver ignores them. Worth surfacing in the help output that they're macOS-only?
- **`environment-details.xml` schema.** Currently writes `dockerHost` as a string. With WSL2 it'll be `tcp://localhost:<port>` instead of `unix://...`. Verify no consumer of this file (including the `diagnose-dev` skill, `test-dev`, etc.) parses the value as a unix path.

## Effort estimate

| Phase | Estimated effort |
|---|---|
| 1 — Base tarball pipeline | ~½ day |
| 2 — `lib/wsl.ts` | ~½ day |
| 3 — Registry extension | ~2 hours |
| 4 — Driver abstraction in `worktree-start.ts` | ~½ day |
| 5 — Windows entrypoints | ~1 hour |
| 6 — Cleanup parity | ~3 hours |
| 7 — Docs | ~3 hours |
| 8 — Test passes | ~1 day |

Total: ~3 days of focused work for a mergeable PR. Most risk is in phase 8 — getting iptables, dockerd, and `localhostForwarding` to play nicely on a real Windows box always surfaces something the design didn't anticipate.

## Out of scope

- **Linux host driver** — explicit.
- **Docker Desktop / Rancher Desktop fallback** — explicit. Could be added later as a third driver if a Windows user objects to managing their own dockerd.
- **Per-distro CPU/RAM caps** — not possible without WSL2 changes upstream.
- **TLS for dockerd TCP listener** — out of scope for single-user dev boxes.
- **Migrating the Linux-on-macOS-via-colima path away from colima** — colima stays the default on macOS.
