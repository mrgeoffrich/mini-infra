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
// NATS host ports are exposed by the vault-nats template. Keep these outside
// the Vault 8200–8299 range and HAProxy ranges so optional host infrastructure
// stacks can run in parallel worktrees without colliding.
export const NATS_CLIENT_PORT_MIN = 4300;
export const NATS_CLIENT_PORT_MAX = 4399;
export const NATS_MONITOR_PORT_MIN = 8600;
export const NATS_MONITOR_PORT_MAX = 8699;

// Per-worktree egress pool slicing: each worktree gets a /22 carved out of
// 172.30.0.0/16, keyed off the same slot the port allocator already uses.
// Slot 0 → 172.30.0.0/22, slot 1 → 172.30.4.0/22, …, slot 63 → 172.30.252.0/22.
// Slots ≥ 64 fall back to the shared default pool with a warning. The server's
// egress-network-allocator reads MINI_INFRA_EGRESS_POOL_CIDR and is size-agnostic,
// so handing it a /22 produces 4 /24 slots; two worktrees in different slots
// reach disjoint /24s by construction with no coordination.
export const DEFAULT_EGRESS_POOL_CIDR = '172.30.0.0/16';
export const EGRESS_PER_WORKTREE_PREFIX = 22;
export const EGRESS_PER_WORKTREE_SLOT_COUNT = 64;

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
  // Per-worktree NATS host ports — surfaced in environment-details.xml for
  // the vault-nats stack template's nats-host-port/nats-monitor-port params.
  nats_client_port: number;
  nats_monitor_port: number;
  admin_email?: string;
  admin_password?: string;
  api_key?: string;
  description?: string;
  // Per-worktree egress pool slice (e.g. "172.30.12.0/22" for slot 3).
  // Stored for visibility in `worktree-env list` output and forensics — the source
  // of truth at runtime is the slot, not this field. Optional so legacy
  // entries written before this rolled out continue to load.
  egress_pool_cidr?: string;
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
    nats_client_port: partial.nats_client_port ?? existing?.nats_client_port ?? 0,
    nats_monitor_port: partial.nats_monitor_port ?? existing?.nats_monitor_port ?? 0,
    admin_email: partial.admin_email ?? existing?.admin_email,
    admin_password: partial.admin_password ?? existing?.admin_password,
    api_key: partial.api_key ?? existing?.api_key,
    description: partial.description ?? existing?.description,
    egress_pool_cidr: partial.egress_pool_cidr ?? existing?.egress_pool_cidr,
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
  nats_client_port: number;
  nats_monitor_port: number;
  egress_pool_cidr: string;
}

/**
 * Compute the per-worktree egress pool CIDR for a given slot. Each worktree
 * gets a /22 (4 contiguous /24s) carved out of 172.30.0.0/16:
 *   slot 0  → 172.30.0.0/22
 *   slot 1  → 172.30.4.0/22
 *   slot 63 → 172.30.252.0/22
 *
 * Slot ≥ EGRESS_PER_WORKTREE_SLOT_COUNT (or < 0) falls back to the shared
 * default pool with a console warning. This keeps the existing 100-slot
 * port ceiling working for slots 64–99 at the cost of reintroducing the
 * original cross-worktree /24 collision risk for that case only — clean up
 * old worktrees with `pnpm worktree-env cleanup` if you see this warning.
 */
export function egressPoolForSlot(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= EGRESS_PER_WORKTREE_SLOT_COUNT) {
    console.warn(
      `Worktree slot ${slot} exceeds per-worktree egress pool capacity ` +
        `(0–${EGRESS_PER_WORKTREE_SLOT_COUNT - 1}); falling back to shared ` +
        `${DEFAULT_EGRESS_POOL_CIDR}. Two concurrent worktrees in this state ` +
        `can collide on /24s — clean up old worktrees with \`pnpm worktree-env cleanup\`.`,
    );
    return DEFAULT_EGRESS_POOL_CIDR;
  }
  return `172.30.${slot * 4}.0/${EGRESS_PER_WORKTREE_PREFIX}`;
}

/**
 * Derive the slot index of a worktree entry by inspecting whichever known
 * port field falls inside its allocator range. Returns undefined for legacy
 * entries with no recognisable port.
 */
export function slotOf(e: WorktreeEntry): number | undefined {
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
  if (
    e.nats_client_port &&
    e.nats_client_port >= NATS_CLIENT_PORT_MIN &&
    e.nats_client_port <= NATS_CLIENT_PORT_MAX
  ) {
    return e.nats_client_port - NATS_CLIENT_PORT_MIN;
  }
  if (
    e.nats_monitor_port &&
    e.nats_monitor_port >= NATS_MONITOR_PORT_MIN &&
    e.nats_monitor_port <= NATS_MONITOR_PORT_MAX
  ) {
    return e.nats_monitor_port - NATS_MONITOR_PORT_MIN;
  }
  return undefined;
}

export function allocatePorts(profile: string): PortAllocation {
  const SLOT_COUNT = UI_PORT_MAX - UI_PORT_MIN + 1;
  const entries = loadRegistry();
  const existing = entries[profile];

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
    nats_client_port: NATS_CLIENT_PORT_MIN + slot,
    nats_monitor_port: NATS_MONITOR_PORT_MIN + slot,
    egress_pool_cidr: egressPoolForSlot(slot),
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
      nats_client_port: uiPort ? NATS_CLIENT_PORT_MIN + slot : 0,
      nats_monitor_port: uiPort ? NATS_MONITOR_PORT_MIN + slot : 0,
      seeded: false,
      updated_at: now,
    };
  }
  saveRegistry(entries);
  logInfo(`Migrated ${Object.keys(entries).length} entries from ${REGISTRY_JSON_LEGACY} to ${REGISTRY_YAML}`);
}
