/**
 * Tests for vault-specific substitution validation extensions:
 *   - {{stack.id}} accepted in vault policy body/name
 *   - {{environment.x}} on host-scoped template rejected (even in vault sections)
 *   - {{inputs.x}} accepted only in vault.kv[].path, and only when declared
 *   - {{inputs.x}} rejected inside services, configFiles, etc.
 *   - Typos like {{inpt.x}} rejected with helpful message
 *   - inputsContext listing: error message reflects whether inputs namespace is valid
 */

import { describe, it, expect } from 'vitest';
import { validateTemplateSubstitutions } from '../services/stacks/template-substitution-validator';

function make(over: Partial<Parameters<typeof validateTemplateSubstitutions>[0]> = {}) {
  return {
    scope: 'environment',
    parameterNames: new Set<string>(),
    inputNames: new Set<string>(),
    services: [],
    configFiles: [],
    networks: [],
    volumes: [],
    resourceInputs: [],
    resourceOutputs: [],
    ...over,
  };
}

// ─── Vault policy sections accept stack.* / environment.* / params.* ──────────

describe('validateTemplateSubstitutions — vault.policies', () => {
  it('accepts {{stack.id}} in vault policy body', () => {
    const issues = validateTemplateSubstitutions(
      make({
        vaultPolicies: [
          {
            name: 'my-policy',
            body: 'path "secret/data/{{stack.id}}/*" { capabilities = ["read"] }',
          },
        ],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('accepts {{stack.id}} in vault policy name', () => {
    const issues = validateTemplateSubstitutions(
      make({
        vaultPolicies: [{ name: '{{stack.id}}-policy', body: 'path "x" { capabilities = ["read"] }' }],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('accepts {{environment.name}} in vault policy on environment-scoped template', () => {
    const issues = validateTemplateSubstitutions(
      make({
        scope: 'environment',
        vaultPolicies: [
          {
            name: '{{environment.name}}-policy',
            body: 'path "x" { capabilities = ["read"] }',
          },
        ],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('rejects {{environment.name}} in vault policy on host-scoped template', () => {
    const issues = validateTemplateSubstitutions(
      make({
        scope: 'host',
        vaultPolicies: [
          {
            name: '{{environment.name}}-policy',
            body: 'y',
          },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/host-scoped/);
  });

  it('rejects unknown namespace in policy body', () => {
    const issues = validateTemplateSubstitutions(
      make({
        vaultPolicies: [{ name: 'p', body: '{{typo.id}}' }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown namespace 'typo'/);
  });

  it('reports path as vault.policies when issue is in policy body', () => {
    const issues = validateTemplateSubstitutions(
      make({
        vaultPolicies: [{ name: 'p', body: '{{bad.key}}' }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toMatch(/^vault\.policies/);
  });
});

// ─── Vault appRoles sections accept stack.* / environment.* / params.* ───────

describe('validateTemplateSubstitutions — vault.appRoles', () => {
  it('accepts {{stack.id}} in appRole name', () => {
    const issues = validateTemplateSubstitutions(
      make({
        vaultAppRoles: [{ name: '{{stack.id}}-approle', policy: 'p' }],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('rejects {{inputs.x}} in appRole name (inputs only valid in KV paths)', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(['botToken']),
        vaultAppRoles: [{ name: '{{inputs.botToken}}-role', policy: 'p' }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/vault\.kv\[\]\.path/);
  });
});

// ─── vault.kv paths ── inputs namespace ──────────────────────────────────────

describe('validateTemplateSubstitutions — vault.kv paths ({{inputs.*}})', () => {
  it('accepts {{inputs.x}} in a KV path when x is declared', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(['botToken']),
        vaultKvPaths: ['stacks/{{inputs.botToken}}/config'],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('rejects {{inputs.x}} in a KV path when x is NOT declared', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(['other']),
        vaultKvPaths: ['stacks/{{inputs.undeclared}}/config'],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown input 'undeclared'/);
    expect(issues[0].message).toMatch(/'other'/); // shows what is declared
  });

  it('rejects {{inputs.x}} in a KV path when no inputs are declared at all', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(),
        vaultKvPaths: ['stacks/{{inputs.botToken}}/config'],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/none defined/);
  });

  it('accepts {{stack.id}} in a KV path (non-inputs namespace still valid)', () => {
    const issues = validateTemplateSubstitutions(
      make({
        vaultKvPaths: ['stacks/{{stack.id}}/config'],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('reports path as vault.kv[N].path when issue is in KV path', () => {
    const issues = validateTemplateSubstitutions(
      make({
        vaultKvPaths: ['ok/path', 'stacks/{{inputs.missing}}/config'],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('vault.kv[1].path');
  });

  it('accepts multiple valid KV paths', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(['tok']),
        vaultKvPaths: [
          'stacks/{{stack.id}}/settings',
          'shared/{{inputs.tok}}/config',
        ],
      }),
    );
    expect(issues).toEqual([]);
  });
});

// ─── {{inputs.*}} is rejected outside KV paths ───────────────────────────────

describe('validateTemplateSubstitutions — {{inputs.*}} outside KV paths', () => {
  it('rejects {{inputs.x}} in services env vars', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(['botToken']),
        services: [{ containerConfig: { env: { SLACK_TOKEN: '{{inputs.botToken}}' } } }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/vault\.kv\[\]\.path/);
  });

  it('rejects {{inputs.x}} in configFiles content', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(['apiKey']),
        configFiles: [{ content: 'api_key = {{inputs.apiKey}}' }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/vault\.kv\[\]\.path/);
  });

  it('rejects {{inputs.x}} in volumes', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(['tok']),
        volumes: [{ name: '{{inputs.tok}}-vol' }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/vault\.kv\[\]\.path/);
  });

  it('error message outside inputs-context does not mention inputs namespace', () => {
    const issues = validateTemplateSubstitutions(
      make({
        services: [{ containerConfig: { env: { K: '{{badns.x}}' } } }],
      }),
    );
    expect(issues).toHaveLength(1);
    // Outside inputsContext, the allowed list should NOT include 'inputs'
    expect(issues[0].message).not.toMatch(/inputs/);
    expect(issues[0].message).toMatch(/params, stack, environment/);
  });
});

// ─── Typos rejected with useful messages ─────────────────────────────────────

describe('validateTemplateSubstitutions — typo detection in vault context', () => {
  it('rejects {{inpt.x}} in a KV path (typo in namespace)', () => {
    const issues = validateTemplateSubstitutions(
      make({
        inputNames: new Set(['botToken']),
        vaultKvPaths: ['stacks/{{inpt.botToken}}/config'],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown namespace 'inpt'/);
  });

  it('rejects {{stack.ids}} typo in vault policy', () => {
    const issues = validateTemplateSubstitutions(
      make({
        vaultPolicies: [{ name: 'p', body: '{{stack.ids}} is wrong' }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown stack key 'ids'/);
  });

  it('inputs namespace in KV path missing-a-namespace token', () => {
    const issues = validateTemplateSubstitutions(
      make({
        vaultKvPaths: ['stacks/{{noNamespaceHere}}/config'],
      }),
    );
    expect(issues).toHaveLength(1);
    // In inputsContext, error message should mention inputs
    expect(issues[0].message).toMatch(/inputs/);
  });
});

// ─── inputNames not provided ──────────────────────────────────────────────────

describe('validateTemplateSubstitutions — inputNames omitted', () => {
  it('treats all {{inputs.*}} as undeclared when inputNames is not set', () => {
    const input = {
      scope: 'environment',
      parameterNames: new Set<string>(),
      // inputNames intentionally omitted
      services: [],
      configFiles: [],
      networks: [],
      volumes: [],
      resourceInputs: [],
      resourceOutputs: [],
      vaultKvPaths: ['stacks/{{inputs.botToken}}/config'],
    };
    const issues = validateTemplateSubstitutions(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/unknown input 'botToken'/);
  });
});
