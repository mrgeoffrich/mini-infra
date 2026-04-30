// Install (or uninstall) the worktree cleanup launchd agent.
//
// Invoked via:
//   pnpm worktree-env install-cleanup-agent           # install
//   pnpm worktree-env install-cleanup-agent --remove  # uninstall

import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logError } from './lib/log.js';

const PLIST_LABEL = 'com.mini-infra.worktree-cleanup';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const MINI_INFRA_HOME =
  process.env.MINI_INFRA_HOME || path.join(os.homedir(), '.mini-infra');
const PLIST_SRC = path.join(SCRIPT_DIR, 'worktree_cleanup.plist');
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_DST = path.join(LAUNCH_AGENTS_DIR, `${PLIST_LABEL}.plist`);

function parseCliArgs(argv: string[]): { remove: boolean } {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        remove: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
    if (values.help) {
      console.log('Usage: pnpm worktree-env install-cleanup-agent [--remove]');
      process.exit(0);
    }
    return { remove: Boolean(values.remove) };
  } catch (err) {
    logError(`Unknown arg: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export function run(argv: string[]): void {
  const args = parseCliArgs(argv);

  if (args.remove) {
    console.log('Unloading and removing worktree cleanup agent...');
    // Tolerate launchctl unload failure — agent may not be loaded.
    spawnSync('launchctl', ['unload', PLIST_DST], { stdio: 'ignore' });
    fs.rmSync(PLIST_DST, { force: true });
    console.log('Done.');
    return;
  }

  fs.mkdirSync(MINI_INFRA_HOME, { recursive: true });
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });

  const template = fs.readFileSync(PLIST_SRC, 'utf8');
  const filled = template
    .replace(/REPO_ROOT/g, REPO_ROOT)
    .replace(/MINI_INFRA_HOME/g, MINI_INFRA_HOME);
  fs.writeFileSync(PLIST_DST, filled);

  // Reload (unload first in case it's already loaded).
  spawnSync('launchctl', ['unload', PLIST_DST], { stdio: 'ignore' });
  const load = spawnSync('launchctl', ['load', PLIST_DST], { stdio: 'inherit' });
  if (load.status !== 0) {
    logError('launchctl load failed');
    process.exit(load.status ?? 1);
  }

  console.log('Worktree cleanup agent installed and loaded.');
  console.log('  Runs every hour.');
  console.log(`  Logs: ${path.join(MINI_INFRA_HOME, 'worktree-cleanup.log')}`);
  console.log(`  Dry run:   pnpm worktree-env cleanup --dry-run`);
  console.log(`  Uninstall: pnpm worktree-env install-cleanup-agent --remove`);
}
