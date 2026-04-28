#!/usr/bin/env -S pnpm dlx tsx@^4.21.0
// Mini Infra Per-Worktree Teardown (TypeScript)
//
// Removes a single worktree's runtime — `docker compose down -v` for its
// Compose project, then deletes the per-worktree VM (Colima profile or WSL2
// distro), then drops its entry from ~/.mini-infra/worktrees.yaml. The git
// worktree itself is left alone (use `git worktree remove` separately).
//
// Usage: tsx worktree-delete.ts <profile> [--force] [--keep-vm]
//   --force     Skip the confirmation prompt
//   --keep-vm   Run compose-down + registry-remove only; leave the VM up

import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import { logInfo, logOk, logWarn, logSkip, logError } from './lib/log.js';
import { colimaExists, deleteColima } from './lib/colima.js';
import {
  defaultInstallDir,
  distroExists,
  distroName,
  unregisterDistro,
} from './lib/wsl.js';
import {
  loadRegistry,
  migrateFromJsonIfNeeded,
  removeEntry,
  MINI_INFRA_HOME,
  WorktreeEntry,
} from './lib/registry.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const COMPOSE_FILE = path.join(SCRIPT_DIR, 'docker-compose.worktree.yaml');

type Driver = 'colima' | 'wsl';

function pickDriver(): Driver {
  const env = process.env.MINI_INFRA_DRIVER;
  if (env === 'colima' || env === 'wsl') return env;
  if (env) {
    logWarn(`Unknown MINI_INFRA_DRIVER='${env}' — falling back to platform default`);
  }
  return process.platform === 'darwin' ? 'colima' : 'wsl';
}

// On Windows, spawnSync without `shell:true` only resolves .exe — it can't
// find .cmd shims like docker.cmd. Mirror the worktree-start.ts pattern.
const NEEDS_SHELL = process.platform === 'win32';

function commandExists(cmd: string): boolean {
  if (process.platform === 'win32') {
    return spawnSync('where', [cmd]).status === 0;
  }
  return spawnSync('command', ['-v', cmd], { shell: '/bin/bash' }).status === 0;
}

function compose(args: string[], env: NodeJS.ProcessEnv): number {
  const res = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: NEEDS_SHELL,
  });
  return res.status ?? 1;
}

function normaliseProfile(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface Args {
  profile: string;
  force: boolean;
  keepVm: boolean;
}

function usage(): void {
  console.log('Usage: worktree-delete <profile> [--force] [--keep-vm]');
  console.log('');
  console.log('  <profile>    The worktree profile name (see worktree_list).');
  console.log('  --force      Skip the confirmation prompt.');
  console.log('  --keep-vm    Run compose-down + registry-remove only; leave the VM up.');
  console.log('  -h, --help   Show this help and exit.');
}

function parseCliArgs(): Args {
  try {
    const { values, positionals } = parseArgs({
      options: {
        force: { type: 'boolean', default: false },
        'keep-vm': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });
    if (values.help) {
      usage();
      process.exit(0);
    }
    if (positionals.length === 0) {
      logError('Missing required <profile> argument.');
      usage();
      process.exit(1);
    }
    if (positionals.length > 1) {
      logError(`Unexpected extra arguments: ${positionals.slice(1).join(' ')}`);
      usage();
      process.exit(1);
    }
    return {
      profile: positionals[0],
      force: Boolean(values.force),
      keepVm: Boolean(values['keep-vm']),
    };
  } catch (err) {
    logError(`Unknown arg: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return /^[Yy]$/.test(answer.trim());
  } finally {
    rl.close();
  }
}

function buildDockerHost(driver: Driver, entry: WorktreeEntry): string | null {
  if (driver === 'colima') {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const sock = path.join(home, '.colima', entry.profile, 'docker.sock');
    if (!fs.existsSync(sock)) return null;
    return `unix://${sock}`;
  }
  if (!entry.docker_port) return null;
  return `tcp://localhost:${entry.docker_port}`;
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const driver = pickDriver();
  const profile = normaliseProfile(args.profile);

  if (!profile) {
    logError(`'${args.profile}' is not a valid profile name.`);
    process.exit(1);
  }

  migrateFromJsonIfNeeded();
  const registry = loadRegistry();
  const entry = registry[profile];
  if (!entry) {
    logError(`No registry entry for profile '${profile}'.`);
    logError('Run deployment/development/worktree_list.sh (or .ps1) to see registered profiles.');
    process.exit(1);
  }

  logInfo(`Profile:   ${profile}`);
  logInfo(`Worktree:  ${entry.worktree_path || '(unknown)'}`);
  logInfo(`Driver:    ${driver}`);
  if (args.keepVm) {
    logInfo('Mode:      keep-vm (compose-down + registry-remove only)');
  } else {
    logInfo('Mode:      full teardown (compose-down + VM delete + registry-remove)');
  }

  if (!args.force) {
    console.log('');
    logWarn(`This will destroy all data for profile '${profile}'.`);
    if (!args.keepVm) {
      if (driver === 'colima') {
        console.log(`  - Colima VM '${profile}' will be deleted (--force).`);
      } else {
        console.log(`  - WSL distro '${distroName(profile)}' will be unregistered.`);
        console.log(`  - VHDX directory ${defaultInstallDir(MINI_INFRA_HOME, profile)} will be removed.`);
      }
    }
    console.log(`  - Compose project 'mini-infra-${profile}' will have all containers and volumes removed.`);
    console.log(`  - Registry entry for '${profile}' will be removed from ~/.mini-infra/worktrees.yaml.`);
    console.log('  - The git worktree itself is left untouched.');
    console.log('');
    const ok = await confirm('Proceed? [y/N] ');
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  if (!commandExists('docker')) {
    logWarn('docker CLI not on PATH — skipping compose down step.');
  } else {
    const dockerHost = buildDockerHost(driver, entry);
    if (!dockerHost) {
      logSkip('No reachable Docker daemon for this profile — skipping compose down.');
    } else {
      const composeProjectName = `mini-infra-${profile}`;
      const stackEnv: NodeJS.ProcessEnv = {
        DOCKER_HOST: dockerHost,
        COMPOSE_PROJECT_NAME: composeProjectName,
        UI_PORT: String(entry.ui_port || 0),
        REGISTRY_PORT: String(entry.registry_port || 0),
        AGENT_SIDECAR_IMAGE_TAG: `localhost:${entry.registry_port || 0}/mini-infra-agent-sidecar:latest`,
        PROJECT_ROOT: entry.worktree_path || PROJECT_ROOT,
        PROFILE: profile,
      };
      logInfo(`Running 'docker compose down -v' for project '${composeProjectName}'...`);
      const rc = compose(['down', '-v', '--remove-orphans'], stackEnv);
      if (rc === 0) {
        logOk('Containers and volumes removed.');
      } else {
        logWarn(`docker compose down exited with status ${rc} (continuing).`);
      }
    }
  }

  if (!args.keepVm) {
    if (driver === 'colima') {
      if (commandExists('colima') && colimaExists(profile)) {
        logInfo(`Deleting Colima VM '${profile}'...`);
        if (deleteColima(profile)) {
          logOk('Colima VM deleted.');
        } else {
          logWarn('colima delete returned non-zero (continuing).');
        }
      } else {
        logSkip(`No Colima VM '${profile}' to delete.`);
      }
    } else {
      const distro = distroName(profile);
      if (commandExists('wsl') && distroExists(distro)) {
        logInfo(`Unregistering WSL distro '${distro}'...`);
        if (unregisterDistro(distro)) {
          logOk('WSL distro unregistered.');
        } else {
          logWarn('wsl --unregister returned non-zero (continuing).');
        }
      } else {
        logSkip(`No WSL distro '${distro}' to unregister.`);
      }
      const installDir = defaultInstallDir(MINI_INFRA_HOME, profile);
      if (fs.existsSync(installDir)) {
        logInfo(`Removing install directory ${installDir}...`);
        try {
          fs.rmSync(installDir, { recursive: true, force: true });
          logOk('Install directory removed.');
        } catch (err) {
          logWarn(`Failed to remove ${installDir}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        logSkip(`Install directory ${installDir} already gone.`);
      }
    }
  } else {
    logSkip('--keep-vm specified — leaving VM running.');
  }

  if (removeEntry(profile)) {
    logOk(`Removed '${profile}' from registry.`);
  } else {
    logSkip(`'${profile}' was not in registry (already clean).`);
  }

  console.log('');
  logOk(`Worktree runtime for '${profile}' has been torn down.`);
  if (entry.worktree_path) {
    console.log('');
    console.log('  The git worktree itself was left alone. To remove it:');
    console.log(`    git worktree remove ${entry.worktree_path}`);
  }
}

main().catch((err) => {
  logError(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
