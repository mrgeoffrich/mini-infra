import { spawnSync } from 'node:child_process';

export function isColimaRunning(profile: string): boolean {
  const res = spawnSync('colima', ['status', profile], { encoding: 'utf8' });
  const combined = (res.stdout || '') + (res.stderr || '');
  return combined.includes('Running');
}

export function colimaExists(profile: string): boolean {
  // `colima status <profile>` exits non-zero for *stopped* VMs as well as
  // missing ones, so it can't distinguish "doesn't exist" from "not running".
  // `colima list --json` enumerates every instance regardless of state.
  const res = spawnSync('colima', ['list', '--json'], { encoding: 'utf8' });
  if (res.status !== 0) return false;
  const stdout = res.stdout || '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { name?: string };
      if (obj?.name === profile) return true;
    } catch {
      // Some colima versions wrap the output in a JSON array; fall through.
    }
  }
  try {
    const arr = JSON.parse(stdout) as Array<{ name?: string }>;
    if (Array.isArray(arr)) {
      return arr.some((entry) => entry?.name === profile);
    }
  } catch {
    // No JSON to parse — treat as not found.
  }
  return false;
}

export interface ColimaStartOpts {
  profile: string;
  cpus: number;
  memoryGib: number;
}

export function startColima(opts: ColimaStartOpts): void {
  const baseArgs = [
    'start',
    opts.profile,
    '--cpu',
    String(opts.cpus),
    '--memory',
    String(opts.memoryGib),
  ];
  const vzArgs = [...baseArgs, '--vm-type', 'vz', '--mount-type', 'virtiofs'];

  const vz = spawnSync('colima', vzArgs, { stdio: ['inherit', 'inherit', 'pipe'] });
  if (vz.status === 0) return;

  const fallback = spawnSync('colima', baseArgs, { stdio: 'inherit' });
  if (fallback.status !== 0) {
    throw new Error(`colima start failed for profile '${opts.profile}'`);
  }
}

export function deleteColima(profile: string): boolean {
  // --data is required to remove the VM's container runtime data (docker
  // volumes, images). Without it the VM directory is removed but a fresh
  // `colima start` on the same profile resurrects the old volumes/images,
  // which breaks compose-up with "volume already exists but was not created
  // by Docker Compose" + a dangling container ID.
  const res = spawnSync('colima', ['delete', profile, '--data', '--force'], { stdio: 'inherit' });
  return res.status === 0;
}
