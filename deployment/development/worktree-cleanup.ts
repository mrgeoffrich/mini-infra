// Mini Infra Worktree Cleanup (TypeScript)
//
// Runs from the main repo checkout (not a worktree). Scans all git worktrees,
// checks via GitHub CLI whether each branch's PR has been merged, and for
// merged ones:
//   1. Deletes the Colima VM
//   2. Removes the git worktree
//   3. Removes the entry from ~/.mini-infra/worktrees.yaml
//
// Invoked via: pnpm worktree-env cleanup [--dry-run] [--repo <owner/repo>]
//
// Designed to be run as a launchd agent (see worktree_cleanup.plist).

import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logInfo, logOk, logWarn, logSkip, logError } from './lib/log.js';
import { colimaExists, deleteColima } from './lib/colima.js';
import {
  cleanupOrphanBridges,
  distroExists,
  distroName,
  forceDockerCleanup,
  isDistroRunning,
  listRunningDistros,
  unregisterDistro,
} from './lib/wsl.js';
import { migrateFromJsonIfNeeded, removeEntry } from './lib/registry.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

type Driver = 'colima' | 'wsl';

function pickDriver(): Driver {
  const env = process.env.MINI_INFRA_DRIVER;
  if (env === 'colima' || env === 'wsl') return env;
  return process.platform === 'darwin' ? 'colima' : 'wsl';
}

function exec(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function commandExists(cmd: string): boolean {
  if (process.platform === 'win32') {
    return spawnSync('where', [cmd]).status === 0;
  }
  return spawnSync('command', ['-v', cmd], { shell: '/bin/bash' }).status === 0;
}

function normaliseProfile(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface Worktree {
  path: string;
  branch?: string;
  detached: boolean;
}

function listWorktrees(repoRoot: string): Worktree[] {
  const { stdout, status } = exec('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (status !== 0) throw new Error('git worktree list failed');

  const worktrees: Worktree[] = [];
  let current: Worktree | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length).trim(), detached: false };
    } else if (line.startsWith('branch ')) {
      if (current) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    } else if (line === 'detached') {
      if (current) current.detached = true;
    } else if (line === '' && current) {
      worktrees.push(current);
      current = null;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

interface Args {
  dryRun: boolean;
  repo?: string;
}

function parseCliArgs(argv: string[]): Args {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean', default: false },
        repo: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
    if (values.help) {
      console.log('Usage: pnpm worktree-env cleanup [--dry-run] [--repo <owner/repo>]');
      process.exit(0);
    }
    return {
      dryRun: Boolean(values['dry-run']),
      repo: values.repo as string | undefined,
    };
  } catch (err) {
    logError(`Unknown arg: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export function run(argv: string[]): void {
  const args = parseCliArgs(argv);
  const driver = pickDriver();

  if (args.dryRun) {
    logWarn('DRY RUN — no changes will be made');
  }

  if (!commandExists('gh')) {
    const hint = process.platform === 'win32'
      ? 'Install from https://cli.github.com/ or `winget install GitHub.cli`'
      : 'Install with: brew install gh';
    logError(`gh CLI is not installed. ${hint}`);
    process.exit(1);
  }
  if (driver === 'colima' && !commandExists('colima')) {
    logError('colima is not installed. Install with: brew install colima');
    process.exit(1);
  }
  if (driver === 'wsl' && !commandExists('wsl')) {
    logError('wsl.exe not found on PATH — WSL2 must be enabled on this host.');
    process.exit(1);
  }

  let repo = args.repo;
  if (!repo) {
    const r = exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      cwd: REPO_ROOT,
    });
    if (r.status === 0) repo = r.stdout.trim();
  }
  if (!repo) {
    logError('Could not detect GitHub repo. Pass --repo <owner/repo>');
    process.exit(1);
  }
  logInfo(`Repo: ${repo}`);

  const worktrees = listWorktrees(REPO_ROOT);
  const mainWorktree = worktrees[0]?.path;
  if (!mainWorktree) {
    logError('No worktrees found');
    process.exit(1);
  }
  if (REPO_ROOT !== mainWorktree) {
    logError(`Must be run from the main checkout (${mainWorktree}), not a worktree (${REPO_ROOT})`);
    process.exit(1);
  }

  migrateFromJsonIfNeeded();

  logInfo(`Scanning worktrees in ${REPO_ROOT}...`);

  let cleaned = 0;
  let skipped = 0;

  for (const wt of worktrees) {
    if (wt.path === mainWorktree) {
      logSkip('Skipping main checkout');
      continue;
    }
    const name = path.basename(wt.path);
    const profile = normaliseProfile(name);

    if (wt.detached || !wt.branch) {
      logSkip(`${name} — detached HEAD, skipping`);
      skipped++;
      continue;
    }

    logInfo(`Checking ${name} (branch: ${wt.branch})`);

    let ageHours = 0;
    try {
      const mtime = fs.statSync(wt.path).mtimeMs;
      ageHours = Math.floor((Date.now() - mtime) / 3600_000);
    } catch {
      ageHours = 0;
    }
    if (ageHours < 2) {
      logSkip(`${name} — only ${ageHours}h old (< 2h), skipping`);
      skipped++;
      continue;
    }

    const prRes = exec('gh', ['pr', 'view', wt.branch, '--repo', repo, '--json', 'state', '--jq', '.state']);
    const prState = prRes.status === 0 ? prRes.stdout.trim() : 'NOT_FOUND';

    if (prState !== 'MERGED') {
      logSkip(`${name} — PR state: ${prState || 'unknown'}, skipping`);
      skipped++;
      continue;
    }

    logOk(`${name} — PR merged, folder ${ageHours}h old — cleaning up`);

    const distro = distroName(profile);

    if (args.dryRun) {
      if (driver === 'colima') {
        console.log(`  [dry-run] colima delete ${profile} --force`);
      } else {
        console.log(`  [dry-run] docker rm -f / network prune inside ${distro} (if running)`);
        console.log(`  [dry-run] sweep orphan bridges from ${distro}`);
        console.log(`  [dry-run] wsl --unregister ${distro}`);
      }
      console.log(`  [dry-run] git worktree remove --force ${wt.path}  (${ageHours}h old)`);
      console.log(`  [dry-run] remove '${profile}' from ~/.mini-infra/worktrees.yaml`);
      cleaned++;
      continue;
    }

    if (driver === 'colima') {
      if (colimaExists(profile)) {
        logInfo(`Deleting Colima VM: ${profile}`);
        if (deleteColima(profile)) {
          logOk('Colima VM deleted');
        } else {
          logWarn('Colima delete returned non-zero (continuing)');
        }
      } else {
        logSkip(`No Colima VM for ${profile}`);
      }
    } else {
      if (distroExists(distro)) {
        // Same orphan-bridge problem as worktree-delete: WSL2 distros share
        // one kernel netns, so leftover `br-<id>` interfaces from a previous
        // dockerd survive the unregister and collide with new daemons'
        // bridges in the FIB. Sweep before unregister; preserve any bridge
        // claimed by another running mini-infra distro.
        if (isDistroRunning(distro)) {
          logInfo(`Forcing Docker cleanup inside ${distro} before unregister`);
          const fc = forceDockerCleanup(distro);
          if (fc.containersRemoved > 0) {
            logOk(`Removed ${fc.containersRemoved} container(s)`);
          }
          if (fc.networksPruned > 0) {
            logOk(`Pruned ${fc.networksPruned} unused network(s)`);
          }
          for (const e of fc.errors) logWarn(`docker cleanup: ${e}`);

          const siblings = listRunningDistros().filter((d) => d !== distro);
          const sweep = cleanupOrphanBridges(distro, siblings);
          if (sweep.deleted.length > 0) {
            logOk(`Deleted ${sweep.deleted.length} orphan bridge(s): ${sweep.deleted.join(', ')}`);
          }
          for (const e of sweep.errors) {
            logWarn(`ip link delete ${e.bridge}: ${e.reason}`);
          }
        }

        logInfo(`Unregistering WSL distro: ${distro}`);
        if (unregisterDistro(distro)) {
          logOk('WSL distro unregistered');
        } else {
          logWarn('wsl --unregister returned non-zero (continuing)');
        }
      } else {
        logSkip(`No WSL distro for ${distro}`);
      }
    }

    logInfo(`Removing git worktree: ${wt.path}`);
    const rm = exec('git', ['worktree', 'remove', '--force', wt.path], { cwd: REPO_ROOT });
    if (rm.status === 0) {
      logOk('Worktree removed');
    } else {
      logWarn('git worktree remove returned non-zero (continuing)');
    }

    if (removeEntry(profile)) {
      logOk(`Removed '${profile}' from registry`);
    } else {
      logSkip(`'${profile}' not in registry (already clean)`);
    }

    cleaned++;
  }

  exec('git', ['worktree', 'prune'], { cwd: REPO_ROOT });

  console.log('');
  logInfo(`Done — cleaned: ${cleaned}, skipped: ${skipped}`);
}
