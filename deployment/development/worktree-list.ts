#!/usr/bin/env -S pnpm dlx tsx@^4.21.0
// Mini Infra Worktree List
//
// Prints every worktree environment recorded in ~/.mini-infra/worktrees.yaml
// as a table — URL, admin login, path, seed status.
//
// Usage: tsx worktree-list.ts [--wide] [--json]
//   --wide   Also show api_key, admin password, colima VM, ports
//   --json   Emit the registry as JSON instead of a table

import { parseArgs } from 'node:util';
import { loadRegistry, REGISTRY_YAML } from './lib/registry.js';
import { logError } from './lib/log.js';

interface Args {
  wide: boolean;
  json: boolean;
}

function parseCliArgs(): Args {
  try {
    const { values } = parseArgs({
      options: {
        wide: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
    if (values.help) {
      console.log('Usage: worktree_list.sh [--wide] [--json]');
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

function main(): void {
  const args = parseCliArgs();
  const entries = loadRegistry();
  const values = Object.values(entries).sort((a, b) => a.profile.localeCompare(b.profile));

  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (values.length === 0) {
    console.log(`No worktree environments registered in ${REGISTRY_YAML}`);
    console.log('Run deployment/development/worktree_start.sh to create one.');
    return;
  }

  const dash = (v: string | undefined): string => (v && v.length ? v : '-');

  const rows: string[][] = [];
  if (args.wide) {
    rows.push([
      'PROFILE',
      'URL',
      'UI',
      'REG',
      'COLIMA VM',
      'ADMIN EMAIL',
      'ADMIN PASSWORD',
      'API KEY',
      'SEEDED',
      'PATH',
    ]);
    for (const e of values) {
      rows.push([
        e.profile,
        dash(e.url),
        e.ui_port ? String(e.ui_port) : '-',
        e.registry_port ? String(e.registry_port) : '-',
        dash(e.colima_vm),
        dash(e.admin_email),
        dash(e.admin_password),
        dash(e.api_key),
        e.seeded ? 'yes' : 'no',
        dash(e.worktree_path),
      ]);
    }
  } else {
    rows.push(['PROFILE', 'URL', 'ADMIN EMAIL', 'SEEDED', 'PATH']);
    for (const e of values) {
      rows.push([
        e.profile,
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

try {
  main();
} catch (err) {
  logError(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
