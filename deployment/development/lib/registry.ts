import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { logInfo } from './log.js';

export const MINI_INFRA_HOME = process.env.MINI_INFRA_HOME || path.join(os.homedir(), '.mini-infra');
export const REGISTRY_YAML = path.join(MINI_INFRA_HOME, 'worktrees.yaml');
export const REGISTRY_JSON_LEGACY = path.join(MINI_INFRA_HOME, 'worktrees.json');
export const DEV_ENV_FILE = path.join(MINI_INFRA_HOME, 'dev.env');

export const UI_PORT_MIN = 3100;
export const UI_PORT_MAX = 3199;
export const REGISTRY_PORT_MIN = 5100;
export const REGISTRY_PORT_MAX = 5199;

export interface WorktreeEntry {
  profile: string;
  worktree_path: string;
  colima_vm: string;
  url: string;
  ui_port: number;
  registry_port: number;
  admin_email?: string;
  admin_password?: string;
  api_key?: string;
  seeded: boolean;
  updated_at: string;
}

interface RegistryFile {
  worktrees: Record<string, WorktreeEntry>;
}

function ensureHome(): void {
  fs.mkdirSync(MINI_INFRA_HOME, { recursive: true });
}

export function loadRegistry(): Record<string, WorktreeEntry> {
  migrateFromJsonIfNeeded();
  if (!fs.existsSync(REGISTRY_YAML)) return {};
  const raw = fs.readFileSync(REGISTRY_YAML, 'utf8');
  const parsed = (yaml.load(raw) as RegistryFile | null) || { worktrees: {} };
  return parsed.worktrees || {};
}

export function saveRegistry(entries: Record<string, WorktreeEntry>): void {
  ensureHome();
  const data: RegistryFile = { worktrees: entries };
  const body = yaml.dump(data, { lineWidth: 200, sortKeys: true });
  fs.writeFileSync(REGISTRY_YAML, body, { mode: 0o600 });
  fs.chmodSync(REGISTRY_YAML, 0o600);
}

export function upsertEntry(
  partial: Partial<WorktreeEntry> & { profile: string },
): WorktreeEntry {
  const entries = loadRegistry();
  const existing = entries[partial.profile];
  const merged: WorktreeEntry = {
    profile: partial.profile,
    worktree_path: partial.worktree_path ?? existing?.worktree_path ?? '',
    colima_vm: partial.colima_vm ?? existing?.colima_vm ?? partial.profile,
    url: partial.url ?? existing?.url ?? '',
    ui_port: partial.ui_port ?? existing?.ui_port ?? 0,
    registry_port: partial.registry_port ?? existing?.registry_port ?? 0,
    admin_email: partial.admin_email ?? existing?.admin_email,
    admin_password: partial.admin_password ?? existing?.admin_password,
    api_key: partial.api_key ?? existing?.api_key,
    seeded: partial.seeded ?? existing?.seeded ?? false,
    updated_at: new Date().toISOString(),
  };
  entries[partial.profile] = merged;
  saveRegistry(entries);
  return merged;
}

export function removeEntry(profile: string): boolean {
  const entries = loadRegistry();
  if (!(profile in entries)) return false;
  delete entries[profile];
  saveRegistry(entries);
  return true;
}

export function allocatePorts(profile: string): { ui_port: number; registry_port: number } {
  const entries = loadRegistry();
  const existing = entries[profile];
  if (existing && existing.ui_port && existing.registry_port) {
    return { ui_port: existing.ui_port, registry_port: existing.registry_port };
  }

  const usedUi = new Set<number>();
  const usedReg = new Set<number>();
  for (const e of Object.values(entries)) {
    if (e.ui_port) usedUi.add(e.ui_port);
    if (e.registry_port) usedReg.add(e.registry_port);
  }

  let ui = 0;
  for (let p = UI_PORT_MIN; p <= UI_PORT_MAX; p++) {
    if (!usedUi.has(p)) {
      ui = p;
      break;
    }
  }
  let reg = 0;
  for (let p = REGISTRY_PORT_MIN; p <= REGISTRY_PORT_MAX; p++) {
    if (!usedReg.has(p)) {
      reg = p;
      break;
    }
  }
  if (!ui || !reg) {
    throw new Error(
      `Port allocation failed — UI range ${UI_PORT_MIN}-${UI_PORT_MAX} or registry range ${REGISTRY_PORT_MIN}-${REGISTRY_PORT_MAX} is exhausted. Check ${REGISTRY_YAML}.`,
    );
  }
  return { ui_port: ui, registry_port: reg };
}

export function migrateFromJsonIfNeeded(): void {
  if (fs.existsSync(REGISTRY_YAML)) return;
  if (!fs.existsSync(REGISTRY_JSON_LEGACY)) return;

  ensureHome();
  type JsonEntry = { profile?: string; ui_port?: number; registry_port?: number };
  type JsonFile = { worktrees?: Record<string, JsonEntry> };

  let parsed: JsonFile;
  try {
    parsed = JSON.parse(fs.readFileSync(REGISTRY_JSON_LEGACY, 'utf8')) as JsonFile;
  } catch {
    parsed = {};
  }
  const legacy = parsed.worktrees || {};
  const entries: Record<string, WorktreeEntry> = {};
  const now = new Date().toISOString();
  for (const [profile, e] of Object.entries(legacy)) {
    const uiPort = e.ui_port || 0;
    entries[profile] = {
      profile,
      worktree_path: '',
      colima_vm: e.profile || profile,
      url: uiPort ? `http://localhost:${uiPort}` : '',
      ui_port: uiPort,
      registry_port: e.registry_port || 0,
      seeded: false,
      updated_at: now,
    };
  }
  saveRegistry(entries);
  logInfo(`Migrated ${Object.keys(entries).length} entries from ${REGISTRY_JSON_LEGACY} to ${REGISTRY_YAML}`);
}
