/**
 * Unit tests for the new host-scoped `nats` template (Phase 2 of the
 * split-vault-nats plan). Asserts:
 *
 *   - The template parses through loadTemplateFromDirectory.
 *   - It declares the expected requires block (vault stack + vault-bootstrapped
 *     predicate) so the apply gate fires correctly when Vault is missing.
 *   - The NATS service is scoped to its own resource network only — Vault KV
 *     reads happen server-side via the dynamicEnv resolver, so the container
 *     itself does not need network access to Vault.
 *   - Parameters / volumes / dynamicEnv match the legacy vault-nats shape so
 *     existing consumers (post-install action, control-plane bootstrap) keep
 *     working unchanged.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { loadTemplateFromDirectory } from '../services/stacks/template-file-loader';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'templates');

describe('nats template.json', () => {
  it('parses successfully via loadTemplateFromDirectory', () => {
    expect(() => loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'nats'))).not.toThrow();
  });

  it('has scope=host and category=infrastructure', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'nats'));
    expect(loaded.scope).toBe('host');
    expect(loaded.category).toBe('infrastructure');
  });

  it('declares the expected cross-stack requires block', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'nats'));
    expect(loaded.requires).toBeDefined();
    expect(loaded.requires).toEqual([
      { kind: 'stack', templateName: 'vault', minState: 'synced', scopeMatch: 'host' },
      { kind: 'predicate', name: 'vault-bootstrapped' },
    ]);
  });

  it('exposes nats-host-port and nats-monitor-port parameters', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'nats'));
    const params = loaded.definition.parameters ?? [];
    const names = params.map((p) => p.name);
    expect(names).toContain('nats-host-port');
    expect(names).toContain('nats-monitor-port');
  });

  it('publishes a nats docker-network resourceOutput', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'nats'));
    const outputs = loaded.definition.resourceOutputs ?? [];
    const natsNetwork = outputs.find(
      (o) => o.type === 'docker-network' && o.purpose === 'nats',
    );
    expect(natsNetwork).toBeDefined();
    expect(natsNetwork?.joinSelf).toBe(true);
  });

  it('declares the nats_data volume', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'nats'));
    expect(loaded.definition.volumes.map((v) => v.name)).toContain('nats_data');
  });

  it('has a single nats service that joins only the nats network (no vault network)', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'nats'));
    expect(loaded.definition.services).toHaveLength(1);
    const svc = loaded.definition.services[0];
    expect(svc.serviceName).toBe('nats');
    expect(svc.containerConfig.joinResourceNetworks).toEqual(['nats']);
  });

  it('reads NATS_CONF and NATS_ACCOUNTS_INDEX via vault-kv dynamicEnv', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'nats'));
    const dynamicEnv = loaded.definition.services[0].containerConfig.dynamicEnv;
    expect(dynamicEnv).toBeDefined();
    expect(dynamicEnv?.NATS_CONF).toEqual({
      kind: 'vault-kv',
      path: 'shared/nats-config',
      field: 'conf',
    });
    expect(dynamicEnv?.NATS_ACCOUNTS_INDEX).toEqual({
      kind: 'vault-kv',
      path: 'shared/nats-accounts-index',
      field: 'index',
    });
  });

  it('does not declare service-level dependsOn since vault is now expressed via requires', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'nats'));
    expect(loaded.definition.services[0].dependsOn).toEqual([]);
  });
});

describe('vault-nats template removal', () => {
  it('the legacy vault-nats template directory is gone', async () => {
    const fs = await import('fs');
    const legacyPath = path.join(TEMPLATES_DIR, 'vault-nats');
    expect(fs.existsSync(legacyPath)).toBe(false);
  });
});

describe('egress-fw-agent template requires NATS', () => {
  it('declares requires with nats stack scopeMatch=host', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'egress-fw-agent'));
    expect(loaded.requires).toBeDefined();
    expect(loaded.requires).toEqual([
      { kind: 'stack', templateName: 'nats', minState: 'synced', scopeMatch: 'host' },
    ]);
  });
});

describe('egress-gateway template requires NATS', () => {
  it('declares requires with nats stack scopeMatch=host', () => {
    const loaded = loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'egress-gateway'));
    expect(loaded.requires).toBeDefined();
    expect(loaded.requires).toEqual([
      { kind: 'stack', templateName: 'nats', minState: 'synced', scopeMatch: 'host' },
    ]);
  });
});
