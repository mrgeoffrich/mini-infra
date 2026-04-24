import { spawnSync } from 'node:child_process';

export function isColimaRunning(profile: string): boolean {
  const res = spawnSync('colima', ['status', profile], { encoding: 'utf8' });
  const combined = (res.stdout || '') + (res.stderr || '');
  return combined.includes('Running');
}

export function colimaExists(profile: string): boolean {
  const res = spawnSync('colima', ['status', profile], { encoding: 'utf8' });
  return res.status === 0;
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
  const res = spawnSync('colima', ['delete', profile, '--force'], { stdio: 'inherit' });
  return res.status === 0;
}
