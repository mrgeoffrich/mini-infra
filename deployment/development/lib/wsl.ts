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
