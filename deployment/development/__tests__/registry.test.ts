import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import {
  allocatePorts,
  DEFAULT_EGRESS_POOL_CIDR,
  egressPoolForSlot,
  EGRESS_PER_WORKTREE_SLOT_COUNT,
  REGISTRY_YAML,
  saveRegistry,
  type WorktreeEntry,
  UI_PORT_MIN,
  REGISTRY_PORT_MIN,
  VAULT_PORT_MIN,
  DOCKER_PORT_MIN,
  HAPROXY_HTTP_PORT_MIN,
  HAPROXY_HTTPS_PORT_MIN,
  HAPROXY_STATS_PORT_MIN,
  HAPROXY_DATAPLANE_PORT_MIN,
} from '../lib/registry.js';

describe('egressPoolForSlot', () => {
  it.each([
    [0, '172.30.0.0/22'],
    [1, '172.30.4.0/22'],
    [3, '172.30.12.0/22'],
    [10, '172.30.40.0/22'],
    [63, '172.30.252.0/22'],
  ])('slot %i → %s', (slot, cidr) => {
    expect(egressPoolForSlot(slot)).toBe(cidr);
  });

  it('slot at boundary (= EGRESS_PER_WORKTREE_SLOT_COUNT) falls back to default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(egressPoolForSlot(EGRESS_PER_WORKTREE_SLOT_COUNT)).toBe(DEFAULT_EGRESS_POOL_CIDR);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('exceeds per-worktree egress pool capacity');
    expect(warn.mock.calls[0][0]).toContain('worktree_cleanup');
    warn.mockRestore();
  });

  it('slot above boundary falls back to default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(egressPoolForSlot(99)).toBe(DEFAULT_EGRESS_POOL_CIDR);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('negative slot falls back to default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(egressPoolForSlot(-1)).toBe(DEFAULT_EGRESS_POOL_CIDR);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('non-integer slot falls back to default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(egressPoolForSlot(1.5)).toBe(DEFAULT_EGRESS_POOL_CIDR);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('NaN slot falls back to default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(egressPoolForSlot(Number.NaN)).toBe(DEFAULT_EGRESS_POOL_CIDR);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('allocatePorts (egress_pool_cidr wiring)', () => {
  beforeEach(() => {
    if (fs.existsSync(REGISTRY_YAML)) fs.rmSync(REGISTRY_YAML);
  });

  afterEach(() => {
    if (fs.existsSync(REGISTRY_YAML)) fs.rmSync(REGISTRY_YAML);
  });

  it('first profile lands in slot 0 with 172.30.0.0/22', () => {
    const alloc = allocatePorts('first');
    expect(alloc.ui_port).toBe(UI_PORT_MIN);
    expect(alloc.egress_pool_cidr).toBe('172.30.0.0/22');
  });

  it('second profile lands in slot 1 with 172.30.4.0/22 (no collision)', () => {
    // Seed slot 0 by upserting a fully-formed entry — allocatePorts only
    // reads ports, so this is enough to mark slot 0 as taken.
    const slot0Entry: WorktreeEntry = {
      profile: 'first',
      worktree_path: '',
      colima_vm: 'first',
      url: '',
      ui_port: UI_PORT_MIN,
      registry_port: REGISTRY_PORT_MIN,
      vault_port: VAULT_PORT_MIN,
      docker_port: DOCKER_PORT_MIN,
      haproxy_http_port: HAPROXY_HTTP_PORT_MIN,
      haproxy_https_port: HAPROXY_HTTPS_PORT_MIN,
      haproxy_stats_port: HAPROXY_STATS_PORT_MIN,
      haproxy_dataplane_port: HAPROXY_DATAPLANE_PORT_MIN,
      seeded: false,
      updated_at: new Date().toISOString(),
    };
    saveRegistry({ first: slot0Entry });

    const alloc = allocatePorts('second');
    expect(alloc.ui_port).toBe(UI_PORT_MIN + 1);
    expect(alloc.egress_pool_cidr).toBe('172.30.4.0/22');
  });

  it('re-allocating the same profile keeps its slot and CIDR', () => {
    const first = allocatePorts('stable');
    const again = allocatePorts('stable');
    expect(again.ui_port).toBe(first.ui_port);
    expect(again.egress_pool_cidr).toBe(first.egress_pool_cidr);
  });

  it('uses the temp registry path, not the user home', () => {
    // Sanity check that the test setup correctly redirects MINI_INFRA_HOME.
    // The mkdtempSync prefix 'mini-infra-test-' lands somewhere under
    // os.tmpdir(); on Windows that's still under the user profile, so this
    // is the strongest check we can make portably.
    expect(REGISTRY_YAML).toContain('mini-infra-test-');
    expect(REGISTRY_YAML).not.toMatch(/\.mini-infra[\\/]worktrees\.yaml$/);
  });
});
