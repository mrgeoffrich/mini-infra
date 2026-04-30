// worktree-env — single CLI for managing the per-worktree dev environment.
//
// Invoked via the root package.json script:
//   pnpm worktree-env <command> [args...]
//
// Subcommands:
//   start                   Bring up (or rebuild) this worktree's instance.
//   list                    List every registered worktree environment.
//   delete <profile>        Tear down a specific worktree's runtime.
//   cleanup                 Sweep merged-PR worktrees (used by the launchd agent).
//   install-cleanup-agent   Install/uninstall the macOS launchd cleanup agent.
//   help                    Show this help.
//
// Each subcommand has its own --help for full options.

import { logError } from './lib/log.js';

type Subcommand = 'start' | 'list' | 'delete' | 'cleanup' | 'install-cleanup-agent';

const SUBCOMMANDS: Record<Subcommand, () => Promise<{ run: (argv: string[]) => void | Promise<void> }>> = {
  start: () => import('./worktree-start.js'),
  list: () => import('./worktree-list.js'),
  delete: () => import('./worktree-delete.js'),
  cleanup: () => import('./worktree-cleanup.js'),
  'install-cleanup-agent': () => import('./worktree-cleanup-install.js'),
};

function topLevelUsage(): void {
  console.log('Usage: pnpm worktree-env <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  start                   Bring up (or rebuild) this worktree\'s instance.');
  console.log('  list                    List every registered worktree environment.');
  console.log('  delete <profile>        Tear down a specific worktree\'s runtime.');
  console.log('  cleanup                 Sweep merged-PR worktrees (run by launchd hourly).');
  console.log('  install-cleanup-agent   Install/uninstall the macOS launchd cleanup agent.');
  console.log('  help                    Show this help.');
  console.log('');
  console.log('Run `pnpm worktree-env <command> --help` for command-specific options.');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    topLevelUsage();
    process.exit(cmd ? 0 : 1);
  }

  const loader = SUBCOMMANDS[cmd as Subcommand];
  if (!loader) {
    logError(`Unknown command: ${cmd}`);
    topLevelUsage();
    process.exit(1);
  }

  const mod = await loader();
  await mod.run(argv.slice(1));
}

main().catch((err) => {
  logError(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
