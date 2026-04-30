// Mini Infra Worktree List
//
// Prints every worktree environment recorded in ~/.mini-infra/worktrees.yaml
// as a table — URL, admin login, path, seed status.
//
// Invoked via: pnpm worktree-env list [--wide] [--json]
//   --wide   Also show api_key, admin password, colima VM, ports
//   --json   Emit the registry as JSON instead of a table

import { parseArgs } from 'node:util';
import {
  DEFAULT_EGRESS_POOL_CIDR,
  EGRESS_PER_WORKTREE_PREFIX,
  EGRESS_PER_WORKTREE_SLOT_COUNT,
  loadRegistry,
  REGISTRY_YAML,
  slotOf,
  type WorktreeEntry,
} from './lib/registry.js';
import { logError } from './lib/log.js';

// Resolve the egress pool for an entry without triggering the warn side-effect
// in egressPoolForSlot (which we don't want spamming the listing output).
// Prefer the persisted field; otherwise compute from slot; otherwise show '-'.
function egressPoolFor(e: WorktreeEntry): string {
  if (e.egress_pool_cidr) return e.egress_pool_cidr;
  const slot = slotOf(e);
  if (slot === undefined) return '-';
  if (slot < 0 || slot >= EGRESS_PER_WORKTREE_SLOT_COUNT) return DEFAULT_EGRESS_POOL_CIDR;
  return `172.30.${slot * 4}.0/${EGRESS_PER_WORKTREE_PREFIX}`;
}

interface Args {
  wide: boolean;
  json: boolean;
}

function parseCliArgs(argv: string[]): Args {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        wide: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
    if (values.help) {
      console.log('Usage: pnpm worktree-env list [--wide] [--json]');
      process.exit(0);
    }
    return { wide: Boolean(values.wide), json: Boolean(values.json) };
  } catch (err) {
    logError(`Unknown arg: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function printTable(rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = rows[0].map((_, colIdx) =>
    Math.max(...rows.map((r) => (r[colIdx] ?? '').length)),
  );
  for (const row of rows) {
    const line = row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ');
    console.log(line.trimEnd());
  }
}

export function run(argv: string[]): void {
  const args = parseCliArgs(argv);
  const entries = loadRegistry();
  const values = Object.values(entries).sort((a, b) => a.profile.localeCompare(b.profile));

  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (values.length === 0) {
    console.log(`No worktree environments registered in ${REGISTRY_YAML}`);
    console.log('Run `pnpm worktree-env start --description "<short>"` to create one.');
    return;
  }

  const dash = (v: string | undefined): string => (v && v.length ? v : '-');

  const rows: string[][] = [];
  if (args.wide) {
    rows.push([
      'PROFILE',
      'DESCRIPTION',
      'URL',
      'UI',
      'REG',
      'VAULT',
      'HAPROXY',
      'EGRESS POOL',
      'VM',
      'ADMIN EMAIL',
      'ADMIN PASSWORD',
      'API KEY',
      'SEEDED',
      'PATH',
    ]);
    for (const e of values) {
      const haproxy = e.haproxy_http_port
        ? `${e.haproxy_http_port}/${e.haproxy_https_port}`
        : '-';
      rows.push([
        e.profile,
        dash(e.description),
        dash(e.url),
        e.ui_port ? String(e.ui_port) : '-',
        e.registry_port ? String(e.registry_port) : '-',
        e.vault_port ? String(e.vault_port) : '-',
        haproxy,
        egressPoolFor(e),
        dash(e.colima_vm),
        dash(e.admin_email),
        dash(e.admin_password),
        dash(e.api_key),
        e.seeded ? 'yes' : 'no',
        dash(e.worktree_path),
      ]);
    }
  } else {
    rows.push(['PROFILE', 'DESCRIPTION', 'URL', 'ADMIN EMAIL', 'SEEDED', 'PATH']);
    for (const e of values) {
      rows.push([
        e.profile,
        dash(e.description),
        dash(e.url),
        dash(e.admin_email),
        e.seeded ? 'yes' : 'no',
        dash(e.worktree_path),
      ]);
    }
  }

  printTable(rows);

  if (!args.wide) {
    console.log('');
    console.log(`(${values.length} environment${values.length === 1 ? '' : 's'} — pass --wide for credentials, --json for machine-readable output)`);
  }
}
