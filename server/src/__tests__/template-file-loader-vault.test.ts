/**
 * Tests for the vault/inputs extensions to templateFileSchema in
 * template-file-loader.ts. Covers:
 *
 *   - Full slackbot-shaped fixture (happy path)
 *   - Cross-validator error cases: unresolved AppRole policy ref, unresolved
 *     KV fromInput, duplicate input names, duplicate policy names, invalid
 *     KV path
 *   - vaultAppRoleRef on services resolves against declared appRoles
 */

import { describe, it, expect } from 'vitest';
import { templateFileSchema } from '../services/stacks/template-file-loader';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const baseService = {
  serviceName: 'slackbot',
  serviceType: 'Stateful' as const,
  dockerImage: 'myorg/slackbot',
  dockerTag: 'latest',
  containerConfig: {},
  dependsOn: [],
  order: 0,
};

const baseTemplate = {
  name: 'slackbot',
  displayName: 'Slack Bot',
  builtinVersion: 1,
  scope: 'environment' as const,
  networks: [],
  volumes: [],
  services: [baseService],
};

// ─── Full slackbot fixture ────────────────────────────────────────────────────

describe('templateFileSchema — full slackbot fixture (happy path)', () => {
  it('accepts a template with inputs[] and vault{} sections', () => {
    const fixture = {
      ...baseTemplate,
      inputs: [
        { name: 'botToken', description: 'Slack Bot OAuth token', sensitive: true, required: true, rotateOnUpgrade: false },
        { name: 'appToken', sensitive: true, required: true, rotateOnUpgrade: true },
      ],
      vault: {
        policies: [
          {
            name: 'slackbot-policy',
            body: 'path "secret/data/{{stack.id}}/*" { capabilities = ["read"] }',
            scope: 'stack',
          },
        ],
        appRoles: [
          {
            name: 'slackbot-approle',
            policy: 'slackbot-policy',
            scope: 'stack',
            tokenTtl: '1h',
          },
        ],
        kv: [
          {
            path: 'stacks/{{stack.id}}/slackbot',
            fields: {
              bot_token: { fromInput: 'botToken' },
              app_token: { fromInput: 'appToken' },
              env_name: { value: '{{environment.name}}' },
            },
          },
        ],
      },
    };

    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inputs).toHaveLength(2);
      expect(result.data.vault?.policies).toHaveLength(1);
      expect(result.data.vault?.appRoles).toHaveLength(1);
      expect(result.data.vault?.kv).toHaveLength(1);
    }
  });

  it('accepts a template with no inputs and no vault', () => {
    const result = templateFileSchema.safeParse(baseTemplate);
    expect(result.success).toBe(true);
  });

  it('accepts a template with inputs but no vault', () => {
    const fixture = {
      ...baseTemplate,
      inputs: [{ name: 'apiKey', sensitive: true, required: true, rotateOnUpgrade: false }],
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it('accepts an empty vault object', () => {
    const fixture = { ...baseTemplate, vault: {} };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it('assigns defaults for sensitive, required, and rotateOnUpgrade', () => {
    const fixture = {
      ...baseTemplate,
      inputs: [{ name: 'token' }],
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      const input = result.data.inputs![0];
      expect(input.sensitive).toBe(true);
      expect(input.required).toBe(true);
      expect(input.rotateOnUpgrade).toBe(false);
    }
  });

  it('accepts service with vaultAppRoleRef that resolves', () => {
    const fixture = {
      ...baseTemplate,
      services: [{ ...baseService, vaultAppRoleRef: 'my-approle' }],
      vault: {
        policies: [{ name: 'my-policy', body: 'path "x" { capabilities = ["read"] }' }],
        appRoles: [{ name: 'my-approle', policy: 'my-policy' }],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });
});

// ─── Cross-validator error cases ──────────────────────────────────────────────

describe('templateFileSchema — cross-validator: AppRole policy ref', () => {
  it('rejects an appRole that references a policy not in this template', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        policies: [{ name: 'real-policy', body: 'path "x" { capabilities = ["read"] }' }],
        appRoles: [{ name: 'my-role', policy: 'nonexistent-policy' }],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("nonexistent-policy"))).toBe(true);
      expect(messages.some((m) => m.includes("AppRole 'my-role'"))).toBe(true);
    }
  });

  it('shows defined policy names in the error message', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        policies: [{ name: 'actual-policy', body: 'path "x" { capabilities = ["read"] }' }],
        appRoles: [{ name: 'r', policy: 'missing' }],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("'actual-policy'"))).toBe(true);
    }
  });

  it('rejects when there are no policies at all', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        appRoles: [{ name: 'r', policy: 'any-policy' }],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('none defined'))).toBe(true);
    }
  });
});

describe('templateFileSchema — cross-validator: KV fromInput ref', () => {
  it('rejects a KV field that references an undeclared input', () => {
    const fixture = {
      ...baseTemplate,
      inputs: [{ name: 'realInput' }],
      vault: {
        kv: [
          {
            path: 'stacks/x/bot',
            fields: {
              token: { fromInput: 'undeclaredInput' },
            },
          },
        ],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("'undeclaredInput'"))).toBe(true);
    }
  });

  it('rejects when inputs array is absent and KV uses fromInput', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        kv: [
          {
            path: 'stacks/x/bot',
            fields: {
              token: { fromInput: 'botToken' },
            },
          },
        ],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });

  it('accepts a KV field using literal value without inputs', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        kv: [
          {
            path: 'stacks/x/settings',
            fields: {
              region: { value: 'ap-southeast-2' },
            },
          },
        ],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });
});

describe('templateFileSchema — cross-validator: duplicate names', () => {
  it('rejects duplicate input names', () => {
    const fixture = {
      ...baseTemplate,
      inputs: [
        { name: 'botToken' },
        { name: 'appToken' },
        { name: 'botToken' }, // duplicate
      ],
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("Duplicate input name: 'botToken'"))).toBe(true);
    }
  });

  it('rejects duplicate policy names', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        policies: [
          { name: 'my-policy', body: 'path "x" { capabilities = ["read"] }' },
          { name: 'other-policy', body: 'path "y" { capabilities = ["read"] }' },
          { name: 'my-policy', body: 'path "z" { capabilities = ["read"] }' }, // duplicate
        ],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("Duplicate policy name: 'my-policy'"))).toBe(true);
    }
  });

  it('rejects duplicate appRole names', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        policies: [
          { name: 'p', body: 'path "x" { capabilities = ["read"] }' },
        ],
        appRoles: [
          { name: 'my-role', policy: 'p' },
          { name: 'my-role', policy: 'p' }, // duplicate
        ],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("Duplicate appRole name: 'my-role'"))).toBe(true);
    }
  });

  it('rejects duplicate KV paths', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        kv: [
          { path: 'shared/config', fields: { k: { value: 'v1' } } },
          { path: 'shared/config', fields: { k: { value: 'v2' } } }, // duplicate path
        ],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("Duplicate KV path: 'shared/config'"))).toBe(true);
    }
  });
});

describe('templateFileSchema — cross-validator: invalid KV path', () => {
  it('rejects a KV path starting with a slash', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        kv: [{ path: '/absolute/path', fields: { k: { value: 'v' } } }],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });

  it('rejects a KV path with double-dot traversal', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        kv: [{ path: 'shared/../secret', fields: { k: { value: 'v' } } }],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });

  it('accepts valid KV paths (plain segments)', () => {
    const fixture = {
      ...baseTemplate,
      vault: {
        kv: [{ path: 'stacks/bot', fields: { k: { value: 'v' } } }],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it('accepts KV paths containing {{...}} template substitutions', () => {
    // Template tokens are stripped before path validation so {{stack.id}} is OK
    const fixture = {
      ...baseTemplate,
      vault: {
        kv: [{ path: 'stacks/{{stack.id}}/config', fields: { k: { value: 'v' } } }],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });
});

describe('templateFileSchema — service vaultAppRoleRef cross-validator', () => {
  it('rejects a service vaultAppRoleRef pointing to an undeclared appRole', () => {
    const fixture = {
      ...baseTemplate,
      services: [{ ...baseService, vaultAppRoleRef: 'ghost-role' }],
      vault: {
        policies: [{ name: 'p', body: 'x' }],
        appRoles: [{ name: 'real-role', policy: 'p' }],
      },
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("'ghost-role'"))).toBe(true);
      expect(messages.some((m) => m.includes("'slackbot'"))).toBe(true);
    }
  });

  it('rejects vaultAppRoleRef when vault has no appRoles at all', () => {
    const fixture = {
      ...baseTemplate,
      services: [{ ...baseService, vaultAppRoleRef: 'any-role' }],
    };
    const result = templateFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });
});
