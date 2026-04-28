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
export const VAULT_PORT_MIN = 8200;
export const VAULT_PORT_MAX = 8299;
export const DOCKER_PORT_MIN = 2500;
export const DOCKER_PORT_MAX = 2599;
// HAProxy gets its host ports overridden per-worktree (rather than using the
// template's 80/443/8404/5555 defaults) so two concurrent worktrees can both
// run an HAProxy without colliding — and so a Windows box with Docker Desktop
// also running doesn't lose to Docker Desktop on port 80.
export const HAPROXY_HTTP_PORT_MIN = 8100;
export const HAPROXY_HTTP_PORT_MAX = 8199;
export const HAPROXY_HTTPS_PORT_MIN = 8500;
export const HAPROXY_HTTPS_PORT_MAX = 8599;
export const HAPROXY_STATS_PORT_MIN = 8400;
export const HAPROXY_STATS_PORT_MAX = 8499;
export const HAPROXY_DATAPLANE_PORT_MIN = 5500;
export const HAPROXY_DATAPLANE_PORT_MAX = 5599;

export interface WorktreeEntry {
  profile: string;
  worktree_path: string;
  // VM identifier — colima profile name on macOS, WSL2 distro name on Windows.
  // Kept named `colima_vm` for backwards compatibility with existing yaml files.
  colima_vm: string;
  url: string;
  ui_port: number;
  registry_port: number;
  vault_port: number;
  // dockerd TCP port inside the WSL2 distro. Unused by the colima driver
  // (dockerd is reached via a unix socket there) but allocated regardless
  // so a registry file is portable across drivers.
  docker_port: number;
  // Per-worktree HAProxy host ports — passed as parameterValues when the
  // seeder instantiates the haproxy stack template.
  haproxy_http_port: number;
  haproxy_https_port: number;
  haproxy_stats_port: number;
  haproxy_dataplane_port: number;
  admin_email?: string;
  admin_password?: string;
  api_key?: string;
  description?: string;
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
    vault_port: partial.vault_port ?? existing?.vault_port ?? 0,
    docker_port: partial.docker_port ?? existing?.docker_port ?? 0,
    haproxy_http_port: partial.haproxy_http_port ?? existing?.haproxy_http_port ?? 0,
    haproxy_https_port: partial.haproxy_https_port ?? existing?.haproxy_https_port ?? 0,
    haproxy_stats_port: partial.haproxy_stats_port ?? existing?.haproxy_stats_port ?? 0,
    haproxy_dataplane_port: partial.haproxy_dataplane_port ?? existing?.haproxy_dataplane_port ?? 0,
    admin_email: partial.admin_email ?? existing?.admin_email,
    admin_password: partial.admin_password ?? existing?.admin_password,
    api_key: partial.api_key ?? existing?.api_key,
    description: partial.description ?? existing?.description,
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

/**
 * Allocate the UI/registry/vault port triple for a worktree as a single
 * "slot" — so each profile's three ports share the same trailing index
 * (slot 0 → 3100/5100/8200, slot 4 → 3104/5104/8204, etc.). This keeps
 * ports easy to reason about and ensures vault never collides with another
 * worktree's slot. Existing entries' ui_port wins as the source of truth
 * for the slot.
 */
export interface PortAllocation {
  ui_port: number;
  registry_port: number;
  vault_port: number;
  docker_port: number;
  haproxy_http_port: number;
  haproxy_https_port: number;
  haproxy_stats_port: number;
  haproxy_dataplane_port: number;
}

export function allocatePorts(profile: string): PortAllocation {
  const SLOT_COUNT = UI_PORT_MAX - UI_PORT_MIN + 1;
  const entries = loadRegistry();
  const existing = entries[profile];

  const slotOf = (e: WorktreeEntry): number | undefined => {
    if (e.ui_port && e.ui_port >= UI_PORT_MIN && e.ui_port <= UI_PORT_MAX) {
      return e.ui_port - UI_PORT_MIN;
    }
    if (e.registry_port && e.registry_port >= REGISTRY_PORT_MIN && e.registry_port <= REGISTRY_PORT_MAX) {
      return e.registry_port - REGISTRY_PORT_MIN;
    }
    if (e.vault_port && e.vault_port >= VAULT_PORT_MIN && e.vault_port <= VAULT_PORT_MAX) {
      return e.vault_port - VAULT_PORT_MIN;
    }
    if (e.docker_port && e.docker_port >= DOCKER_PORT_MIN && e.docker_port <= DOCKER_PORT_MAX) {
      return e.docker_port - DOCKER_PORT_MIN;
    }
    if (
      e.haproxy_http_port &&
      e.haproxy_http_port >= HAPROXY_HTTP_PORT_MIN &&
      e.haproxy_http_port <= HAPROXY_HTTP_PORT_MAX
    ) {
      return e.haproxy_http_port - HAPROXY_HTTP_PORT_MIN;
    }
    return undefined;
  };

  const usedSlots = new Set<number>();
  for (const e of Object.values(entries)) {
    if (e.profile === profile) continue;
    const s = slotOf(e);
    if (s !== undefined) usedSlots.add(s);
  }

  let slot = existing ? slotOf(existing) : undefined;
  if (slot === undefined) {
    for (let s = 0; s < SLOT_COUNT; s++) {
      if (!usedSlots.has(s)) {
        slot = s;
        break;
      }
    }
  }
  if (slot === undefined) {
    throw new Error(
      `Port allocation failed — all ${SLOT_COUNT} slots in use. Check ${REGISTRY_YAML}.`,
    );
  }
  return {
    ui_port: UI_PORT_MIN + slot,
    registry_port: REGISTRY_PORT_MIN + slot,
    vault_port: VAULT_PORT_MIN + slot,
    docker_port: DOCKER_PORT_MIN + slot,
    haproxy_http_port: HAPROXY_HTTP_PORT_MIN + slot,
    haproxy_https_port: HAPROXY_HTTPS_PORT_MIN + slot,
    haproxy_stats_port: HAPROXY_STATS_PORT_MIN + slot,
    haproxy_dataplane_port: HAPROXY_DATAPLANE_PORT_MIN + slot,
  };
}

export function migrateFromJsonIfNeeded(): void {
  if (fs.existsSync(REGISTRY_YAML)) return;
  if (!fs.existsSync(REGISTRY_JSON_LEGACY)) return;

  ensureHome();
  type JsonEntry = { profile?: string; ui_port?: number; registry_port?: number; vault_port?: number };
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
    // docker_port and haproxy_* weren't tracked before — derive from the
    // slot index of ui_port so migrated entries stay slot-aligned.
    const slot = uiPort >= UI_PORT_MIN && uiPort <= UI_PORT_MAX ? uiPort - UI_PORT_MIN : 0;
    entries[profile] = {
      profile,
      worktree_path: '',
      colima_vm: e.profile || profile,
      url: uiPort ? `http://localhost:${uiPort}` : '',
      ui_port: uiPort,
      registry_port: e.registry_port || 0,
      vault_port: e.vault_port || 0,
      docker_port: uiPort ? DOCKER_PORT_MIN + slot : 0,
      haproxy_http_port: uiPort ? HAPROXY_HTTP_PORT_MIN + slot : 0,
      haproxy_https_port: uiPort ? HAPROXY_HTTPS_PORT_MIN + slot : 0,
      haproxy_stats_port: uiPort ? HAPROXY_STATS_PORT_MIN + slot : 0,
      haproxy_dataplane_port: uiPort ? HAPROXY_DATAPLANE_PORT_MIN + slot : 0,
      seeded: false,
      updated_at: now,
    };
  }
  saveRegistry(entries);
  logInfo(`Migrated ${Object.keys(entries).length} entries from ${REGISTRY_JSON_LEGACY} to ${REGISTRY_YAML}`);
}
