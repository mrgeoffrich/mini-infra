// WSL2 driver — Windows analog of lib/colima.ts.
//
// Each worktree gets its own WSL2 distro named `mini-infra-<profile>` cloned
// from the cached Alpine + dockerd tarball at `~/.mini-infra/wsl-base.tar`
// (produced by scripts/build-wsl-base.ps1). The distro hosts dockerd on
// `tcp://0.0.0.0:<docker_port>` plus `unix:///var/run/docker.sock`. WSL2's
// localhostForwarding makes `tcp://localhost:<docker_port>` reachable from
// Windows; the unix socket is what the mini-infra container bind-mounts.
//
// Distro names are namespaced (`mini-infra-` prefix) so they never collide
// with a user-installed Ubuntu or whatever else they have.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DISTRO_PREFIX = 'mini-infra-';
const WSL = 'wsl.exe';

export function distroName(profile: string): string {
  return `${DISTRO_PREFIX}${profile}`;
}

interface WslListEntry {
  name: string;
  state: string;
  version: string;
}

/**
 * `wsl -l -v` emits UTF-16 little-endian. Node's spawnSync with `encoding`
 * decodes as UTF-8 by default, which produces strings full of nulls. Reading
 * the buffer raw and decoding manually avoids that.
 */
function listDistros(): WslListEntry[] {
  const res = spawnSync(WSL, ['-l', '-v'], { encoding: 'buffer' });
  if (res.status !== 0) return [];
  // wsl emits BOM-prefixed UTF-16 LE on the Windows side.
  const text = res.stdout.toString('utf16le').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  // First line is a header. Strip the leading `*` marker on the default distro.
  const out: WslListEntry[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/^\s*\*?\s*/, '').trimEnd();
    const cols = line.split(/\s+/);
    if (cols.length < 3) continue;
    out.push({ name: cols[0], state: cols[1], version: cols[2] });
  }
  return out;
}

export function distroExists(name: string): boolean {
  return listDistros().some((d) => d.name === name);
}

export function isDistroRunning(name: string): boolean {
  const entry = listDistros().find((d) => d.name === name);
  return entry?.state === 'Running';
}

/**
 * Names of every running WSL distro. Used by the orphan-bridge sweep so we
 * know which other Docker daemons might still be claiming bridges that
 * appear (in the shared netns) inside the distro we're about to unregister.
 */
export function listRunningDistros(): string[] {
  return listDistros()
    .filter((d) => d.state === 'Running')
    .map((d) => d.name);
}

export interface WslImportOpts {
  name: string;
  baseTarball: string;
  installDir: string;
}

export function importDistro(opts: WslImportOpts): void {
  if (!fs.existsSync(opts.baseTarball)) {
    throw new Error(
      `Base tarball not found at ${opts.baseTarball}. ` +
        'Run scripts\\build-wsl-base.ps1 first.',
    );
  }
  fs.mkdirSync(opts.installDir, { recursive: true });
  const res = spawnSync(WSL, ['--import', opts.name, opts.installDir, opts.baseTarball], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`wsl --import failed for distro ${opts.name}`);
  }
}

export function unregisterDistro(name: string): boolean {
  const res = spawnSync(WSL, ['--unregister', name], { stdio: 'inherit' });
  return res.status === 0;
}

export interface WslStartDockerOpts {
  name: string;
  dockerPort: number;
}

/**
 * Ensure dockerd is running on the requested TCP port inside the distro.
 *
 * Calls the baked-in `/etc/mini-infra/start-dockerd.sh <port>` which uses
 * `setsid -f` to detach dockerd from the wsl-session shell. Without setsid,
 * the daemon dies when the invoking shell exits — WSL kills children of an
 * exiting session even when nohup'd. setsid moves it into a new session
 * parented to init.
 *
 * Idempotent — the helper script no-ops if dockerd is already running.
 * dockerd's TLS-warning startup pause means the listener takes ~15-20s to
 * bind even after this returns; pair with `ensureDockerReady`.
 */
export function startDocker(opts: WslStartDockerOpts): void {
  const res = spawnSync(
    WSL,
    ['-d', opts.name, '--', '/etc/mini-infra/start-dockerd.sh', String(opts.dockerPort)],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) {
    throw new Error(`Failed to start dockerd in distro ${opts.name}`);
  }
}

/**
 * Poll the dockerd TCP listener until it responds or attempts run out.
 * Resolves true on success, false on timeout. Uses fetch against the
 * dockerd ping endpoint (`/_ping`) which all dockerd versions expose.
 *
 * Default of 60 attempts is set high because dockerd intentionally pauses
 * ~15 s on startup when binding to a TCP host without --tlsverify (a foot-
 * gun warning baked into recent dockerd builds). On a cold boot of the
 * distro, expect the first probe success around the 18–25 s mark.
 */
export async function ensureDockerReady(
  dockerPort: number,
  attempts = 60,
): Promise<boolean> {
  const url = `http://localhost:${dockerPort}/_ping`;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // dockerd not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Resolve a Windows path (like `C:\Users\...`) to its WSL2 mount path
 * (like `/mnt/c/Users/...`). Handy for translating `PROJECT_ROOT` for
 * commands run inside the distro. Returns null if wslpath isn't usable
 * (e.g. distro not running). Currently unused by the orchestrator but
 * exposed for future use — bind-mounts in compose are daemon-side, so
 * we don't need this on the hot path.
 */
export function wslPath(distro: string, windowsPath: string): string | null {
  const res = spawnSync(WSL, ['-d', distro, '--', 'wslpath', '-u', windowsPath], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return null;
  const out = res.stdout.trim();
  return out || null;
}

/**
 * Best-effort: ensure WSL2 is installed and at least one feature-enabled
 * distro can run. Throws with a friendly message otherwise.
 */
export function assertWslAvailable(): void {
  const res = spawnSync(WSL, ['--status'], { encoding: 'buffer' });
  if (res.status !== 0) {
    throw new Error(
      'WSL2 is not available on this host. Run `wsl --install` from an admin PowerShell and reboot.',
    );
  }
}

/**
 * The cached base tarball location. Mirrors the path
 * scripts/build-wsl-base.ps1 writes to.
 */
export function defaultBaseTarballPath(miniInfraHome: string): string {
  return path.join(miniInfraHome, 'wsl-base.tar');
}

/**
 * The per-distro install directory under MINI_INFRA_HOME. WSL stores the
 * VHDX disk file under here.
 */
export function defaultInstallDir(miniInfraHome: string, profile: string): string {
  return path.join(miniInfraHome, 'wsl', profile);
}

/**
 * Run a single command inside a WSL distro and capture its UTF-8 stdout.
 *
 * Linux processes write UTF-8; only the `wsl -l/-v` family emits UTF-16
 * (those are Windows-side outputs from the wsl.exe wrapper). Anything we
 * launch with `wsl -d <distro> -- <cmd>` goes straight to the Linux pipe.
 */
function execInDistro(
  distro: string,
  cmd: string[],
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(WSL, ['-d', distro, '--', ...cmd], { encoding: 'utf8' });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/**
 * The 12-char hex network IDs that Docker uses as bridge name suffixes.
 * Returns an empty set if the daemon isn't reachable (distro stopped, no
 * dockerd, etc.) — callers should treat that as "claims nothing".
 */
export function listDockerNetworkIds(distro: string): Set<string> {
  const res = execInDistro(distro, ['docker', 'network', 'ls', '-q', '--no-trunc']);
  if (res.status !== 0) return new Set();
  const ids = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    const id = line.trim();
    if (id.length >= 12) ids.add(id.slice(0, 12));
  }
  return ids;
}

/**
 * Lists `br-XXXXXXXXXXXX` bridge interfaces visible from inside `distro`.
 *
 * NOTE: WSL2's default NAT-mode networking puts every running distro in
 * the same kernel network namespace (verifiable via `readlink /proc/self/ns/net`
 * — they all return the same id). So this returns bridges created by any
 * distro's dockerd, not just the target's.
 *
 * The Alpine base image ships BusyBox `ip`, which doesn't accept
 * `show type bridge`, so we use plain `ip link` and grep the names
 * ourselves. The Docker bridge naming convention is rigid enough
 * (`br-` + first 12 chars of the network ID) that the regex is safe.
 */
export function listKernelBridges(distro: string): string[] {
  const res = execInDistro(distro, ['ip', '-o', 'link']);
  if (res.status !== 0) return [];
  const out: string[] = [];
  for (const line of res.stdout.split('\n')) {
    // `ip -o link` rows look like: `4: br-effde9cded84: <BROADCAST,...> mtu 1500 ...`
    const m = line.match(/^\d+:\s+(br-[a-f0-9]{12}):/);
    if (m) out.push(m[1]);
  }
  return out;
}

export interface OrphanBridgeSweep {
  deleted: string[];
  preserved: string[];
  errors: { bridge: string; reason: string }[];
}

/**
 * Sweep orphaned `br-XXXXXXXXXXXX` interfaces from the shared WSL2 kernel
 * netns by running `ip link delete` from inside `targetDistro`. A bridge
 * is preserved if its 12-char id appears in any `liveDistros[i]`'s
 * `docker network ls -q` output; otherwise it is deleted.
 *
 * Background: dockerd creates each bridge as `br-` + first 12 chars of
 * the network ID. When a Docker network is left over from a partial
 * shutdown — the daemon DB lost track of it but the kernel still has
 * the interface — the bridge becomes an "orphan" with a phantom subnet
 * route that beats the legitimate route in the FIB. That's the bug
 * `fix(worktree): clean up orphaned Linux bridges on worktree delete`
 * is targeting.
 *
 * Two intended call sites:
 *  - Pre-unregister cleanup (`worktree-delete`, `worktree-cleanup`):
 *    pass every running mini-infra distro EXCEPT the doomed one. The
 *    doomed distro's networks become "not live" and are swept, while
 *    sibling worktrees' bridges are preserved.
 *  - Defensive pre-start sweep: pass every running mini-infra distro
 *    INCLUDING the target. Only true orphans (no dockerd claims them)
 *    are removed.
 *
 * Caveat: deleting a bridge here removes it for every distro because
 * the netns is shared. Get the `liveDistros` list right or you'll yank
 * an active bridge out from under another worktree's daemon.
 */
export function cleanupOrphanBridges(
  targetDistro: string,
  liveDistros: string[],
): OrphanBridgeSweep {
  const protectedIds = new Set<string>();
  for (const d of liveDistros) {
    for (const id of listDockerNetworkIds(d)) protectedIds.add(id);
  }

  const result: OrphanBridgeSweep = { deleted: [], preserved: [], errors: [] };
  for (const bridge of listKernelBridges(targetDistro)) {
    const id = bridge.slice(3); // strip "br-"
    if (protectedIds.has(id)) {
      result.preserved.push(bridge);
      continue;
    }
    const res = execInDistro(targetDistro, ['ip', 'link', 'delete', bridge]);
    if (res.status === 0) {
      result.deleted.push(bridge);
    } else {
      result.errors.push({ bridge, reason: res.stderr.trim() || `exit ${res.status}` });
    }
  }
  return result;
}

/**
 * Force-stop every container, then prune unused networks, in `distro`'s
 * Docker daemon. Used as a pre-unregister cleanup so dockerd can normally
 * remove the bridges it created — leaving `cleanupOrphanBridges` as a
 * safety net for any that don't go quietly.
 *
 * Best-effort and tolerant of partial failure.
 */
export function forceDockerCleanup(distro: string): {
  containersRemoved: number;
  networksPruned: number;
  errors: string[];
} {
  const errors: string[] = [];

  // Force-remove every container (running or stopped) so no network has
  // attached endpoints when we prune.
  const ps = execInDistro(distro, ['docker', 'ps', '-aq']);
  const containerIds = ps.status === 0
    ? ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  let containersRemoved = 0;
  if (containerIds.length > 0) {
    const rm = execInDistro(distro, ['docker', 'rm', '-f', ...containerIds]);
    if (rm.status === 0) {
      containersRemoved = rm.stdout.split('\n').filter(Boolean).length;
    } else {
      errors.push(`docker rm -f: ${rm.stderr.trim() || `exit ${rm.status}`}`);
    }
  }

  // Prune unused networks. Counts the lines after the "Deleted Networks:" header.
  const prune = execInDistro(distro, ['docker', 'network', 'prune', '-f']);
  let networksPruned = 0;
  if (prune.status === 0) {
    const m = prune.stdout.match(/Deleted Networks:\s*\n([\s\S]*)/);
    if (m) networksPruned = m[1].split('\n').map((s) => s.trim()).filter(Boolean).length;
  } else {
    errors.push(`docker network prune: ${prune.stderr.trim() || `exit ${prune.status}`}`);
  }

  return { containersRemoved, networksPruned, errors };
}
