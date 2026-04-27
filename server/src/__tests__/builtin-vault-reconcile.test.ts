/**
 * Unit tests for hello-vault template.json and system template invariants.
 *
 * These are pure-unit tests (no DB). DB-backed tests for runBuiltinVaultReconcile
 * and runSystemStackMigrations live in builtin-vault-reconcile.integration.test.ts.
 *
 * Covers:
 *   - hello-vault template parses correctly and has the expected vault section
 *   - builtinVersion on hello-vault is 2
 *   - Service vaultAppRoleRef matches declared appRole
 *   - All 7 system templates parse without errors
 *   - Cross-references in vault sections are valid for every system template
 *   - Templates without vault sections have no service vaultAppRoleRef
 */

import { describe, it, expect } from 'vitest';
import { loadTemplateFromDirectory, loadTemplateFromObject } from '../services/stacks/template-file-loader';
import * as fs from 'fs';
import * as path from 'path';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'templates');

function loadTemplate(name: string): ReturnType<typeof loadTemplateFromDirectory> {
  return loadTemplateFromDirectory(path.join(TEMPLATES_DIR, name));
}

function getTemplateNames(): string[] {
  return fs.readdirSync(TEMPLATES_DIR).filter((d) => {
    return (
      fs.statSync(path.join(TEMPLATES_DIR, d)).isDirectory() &&
      fs.existsSync(path.join(TEMPLATES_DIR, d, 'template.json'))
    );
  });
}

// ─── hello-vault template ─────────────────────────────────────────────────────

describe('hello-vault template.json', () => {
  it('parses successfully through loadTemplateFromObject', () => {
    expect(() => loadTemplate('hello-vault')).not.toThrow();
  });

  it('has builtinVersion 2', () => {
    expect(loadTemplate('hello-vault').builtinVersion).toBe(2);
  });

  it('declares exactly one policy and one appRole', () => {
    const loaded = loadTemplate('hello-vault');
    expect(loaded.vault?.policies).toHaveLength(1);
    expect(loaded.vault?.appRoles).toHaveLength(1);
  });

  it('policy is named hello-vault-read', () => {
    const loaded = loadTemplate('hello-vault');
    expect(loaded.vault?.policies?.[0].name).toBe('hello-vault-read');
  });

  it('appRole references hello-vault-read policy', () => {
    const loaded = loadTemplate('hello-vault');
    expect(loaded.vault?.appRoles?.[0].name).toBe('hello-vault');
    expect(loaded.vault?.appRoles?.[0].policy).toBe('hello-vault-read');
  });

  it('appRole has reasonable TTLs', () => {
    const loaded = loadTemplate('hello-vault');
    const ar = loaded.vault?.appRoles?.[0];
    expect(ar?.tokenTtl).toBe('1h');
    expect(ar?.tokenMaxTtl).toBe('4h');
    expect(ar?.secretIdTtl).toBe('10m');
    expect(ar?.secretIdNumUses).toBe(1);
  });

  it('hello service has vaultAppRoleRef pointing to hello-vault appRole', () => {
    const loaded = loadTemplate('hello-vault');
    const svc = loaded.definition.services.find((s) => s.serviceName === 'hello');
    expect(svc?.vaultAppRoleRef).toBe('hello-vault');
  });

  it('has no kv entries (secrets are read at runtime, not injected at apply)', () => {
    const loaded = loadTemplate('hello-vault');
    expect(loaded.vault?.kv ?? []).toHaveLength(0);
  });
});

// ─── All system templates ─────────────────────────────────────────────────────

describe('system templates — parse without errors', () => {
  it('loads all 7 system templates without throwing', () => {
    const names = getTemplateNames();
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      expect(() => loadTemplate(name), `template ${name} should parse`).not.toThrow();
    }
  });

  it('every template has a positive builtinVersion', () => {
    for (const name of getTemplateNames()) {
      expect(loadTemplate(name).builtinVersion, `${name} builtinVersion`).toBeGreaterThan(0);
    }
  });
});

describe('system templates — vault cross-references', () => {
  it('AppRole policy refs resolve within the same template', () => {
    for (const name of getTemplateNames()) {
      const loaded = loadTemplate(name);
      if (!loaded.vault) continue;
      const policyNames = new Set((loaded.vault.policies ?? []).map((p) => p.name));
      for (const ar of loaded.vault.appRoles ?? []) {
        expect(
          policyNames.has(ar.policy),
          `AppRole '${ar.name}' in '${name}' references undeclared policy '${ar.policy}'`,
        ).toBe(true);
      }
    }
  });

  it('service vaultAppRoleRef values resolve to declared appRoles', () => {
    for (const name of getTemplateNames()) {
      const loaded = loadTemplate(name);
      const arNames = new Set((loaded.vault?.appRoles ?? []).map((a) => a.name));
      for (const svc of loaded.definition.services) {
        if (!svc.vaultAppRoleRef) continue;
        expect(
          arNames.has(svc.vaultAppRoleRef),
          `Service '${svc.serviceName}' in '${name}' vaultAppRoleRef '${svc.vaultAppRoleRef}' not found in declared appRoles`,
        ).toBe(true);
      }
    }
  });

  it('templates without vault sections have no service vaultAppRoleRef', () => {
    for (const name of getTemplateNames()) {
      const loaded = loadTemplate(name);
      if (loaded.vault) continue;
      for (const svc of loaded.definition.services) {
        expect(
          svc.vaultAppRoleRef,
          `Service '${svc.serviceName}' in '${name}' has vaultAppRoleRef but template has no vault section`,
        ).toBeUndefined();
      }
    }
  });

  it('KV fromInput refs resolve to declared inputs', () => {
    for (const name of getTemplateNames()) {
      const loaded = loadTemplate(name);
      if (!loaded.vault?.kv?.length) continue;
      const inputNames = new Set((loaded.inputs ?? []).map((i) => i.name));
      for (const kv of loaded.vault.kv) {
        for (const [field, spec] of Object.entries(kv.fields)) {
          if ('fromInput' in spec) {
            expect(
              inputNames.has(spec.fromInput),
              `KV path '${kv.path}' field '${field}' references undeclared input '${spec.fromInput}' in '${name}'`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

// ─── Structural test: hello-vault vault section ───────────────────────────────

describe('hello-vault vault section structure', () => {
  it('has the expected policy and appRole names and scopes', () => {
    const loaded = loadTemplate('hello-vault');
    expect(loaded.vault?.policies?.[0]).toMatchObject({
      name: 'hello-vault-read',
      scope: 'environment',
      description: expect.any(String),
      body: expect.stringContaining('secret/data/hello-vault'),
    });
    expect(loaded.vault?.appRoles?.[0]).toMatchObject({
      name: 'hello-vault',
      policy: 'hello-vault-read',
      scope: 'environment',
      tokenTtl: '1h',
      tokenMaxTtl: '4h',
      secretIdTtl: '10m',
      secretIdNumUses: 1,
    });
  });
});
