import { describe, it, expect } from 'vitest';

import {
  createTemplateSchema,
  draftVersionSchema,
} from '../services/stacks/stack-template-schemas';
import { stackServiceDefinitionSchema } from '../services/stacks/schemas';

const baseService = {
  serviceName: 'web',
  serviceType: 'Stateful' as const,
  dockerImage: 'nginx',
  dockerTag: 'latest',
  containerConfig: {},
  dependsOn: [],
  order: 0,
};

const baseCreate = {
  name: 'test-app',
  displayName: 'Test App',
  scope: 'environment' as const,
  networks: [],
  volumes: [],
  services: [baseService],
};

describe('createTemplateSchema — networkType', () => {
  it('accepts networkType=local', () => {
    const r = createTemplateSchema.safeParse({ ...baseCreate, networkType: 'local' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.networkType).toBe('local');
  });

  it('accepts networkType=internet', () => {
    const r = createTemplateSchema.safeParse({ ...baseCreate, networkType: 'internet' });
    expect(r.success).toBe(true);
  });

  it('rejects unknown networkType', () => {
    const r = createTemplateSchema.safeParse({ ...baseCreate, networkType: 'corpnet' });
    expect(r.success).toBe(false);
  });
});

describe('createTemplateSchema — networkTypeDefaults', () => {
  it('accepts keys "local" and "internet"', () => {
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      networkTypeDefaults: {
        local: { port: 80 },
        internet: { port: 443 },
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown network-type keys', () => {
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      networkTypeDefaults: {
        LOCAL: { port: 80 }, // wrong case
      },
    });
    expect(r.success).toBe(false);
  });

  it('strips __proto__ and other non-enum keys so they cannot reach downstream code', () => {
    // Real requests arrive via JSON.parse, where __proto__ is a regular own
    // property; Zod silently drops it because it isn't in the enum.
    const parsed = JSON.parse(
      '{"__proto__": {"polluted": true}, "local": {"port": 80}}',
    );
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      networkTypeDefaults: parsed,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.networkTypeDefaults).toEqual({ local: { port: 80 } });
      expect(Object.getOwnPropertyNames(r.data.networkTypeDefaults ?? {})).not.toContain(
        '__proto__',
      );
    }
  });
});

describe('createTemplateSchema — empty services', () => {
  it('accepts an empty services array (publish-time check enforces min=1)', () => {
    const r = createTemplateSchema.safeParse({ ...baseCreate, services: [] });
    expect(r.success).toBe(true);
  });
});

describe('createTemplateSchema — inputs and vault (single-call create)', () => {
  it('accepts inputs[] alongside services and round-trips defaults', () => {
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      inputs: [{ name: 'apiKey' }, { name: 'dbPassword', sensitive: true, required: false }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.inputs).toHaveLength(2);
      // Default sensitive=true, required=true, rotateOnUpgrade=false
      expect(r.data.inputs![0].sensitive).toBe(true);
      expect(r.data.inputs![0].required).toBe(true);
      expect(r.data.inputs![0].rotateOnUpgrade).toBe(false);
    }
  });

  it('accepts a complete vault section with policies, appRoles, and kv', () => {
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      inputs: [{ name: 'token' }],
      vault: {
        policies: [{ name: 'p1', body: 'path "secret/*" { capabilities = ["read"] }' }],
        appRoles: [{ name: 'r1', policy: 'p1' }],
        kv: [{ path: 'shared/cfg', fields: { token: { fromInput: 'token' } } }],
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.vault?.policies).toHaveLength(1);
      expect(r.data.vault?.appRoles).toHaveLength(1);
      expect(r.data.vault?.kv).toHaveLength(1);
    }
  });

  it('accepts an empty vault object (treated as no vault section)', () => {
    const r = createTemplateSchema.safeParse({ ...baseCreate, vault: {} });
    expect(r.success).toBe(true);
  });

  it('rejects an invalid vault.kv path', () => {
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      vault: {
        kv: [{ path: '/leading-slash', fields: { k: { value: 'v' } } }],
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate input names via Zod default uniqueness — schema accepts dupes; cross-validator catches them at the loader level', () => {
    // The Zod schema itself does NOT enforce input-name uniqueness at the
    // create-template layer (mirrors draftVersionSchema). Loader/runtime
    // catches duplicates. This test pins that contract so a future
    // refactor that adds uniqueness here is intentional.
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      inputs: [{ name: 'dup' }, { name: 'dup' }],
    });
    expect(r.success).toBe(true);
  });
});

describe('draftVersionSchema', () => {
  const baseDraft = { networks: [], volumes: [], services: [baseService] };

  it('accepts networkTypeDefaults and round-trips the field', () => {
    const r = draftVersionSchema.safeParse({
      ...baseDraft,
      networkTypeDefaults: { local: { port: 80 } },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.networkTypeDefaults).toEqual({ local: { port: 80 } });
  });

  it('accepts an empty services array', () => {
    const r = draftVersionSchema.safeParse({ ...baseDraft, services: [] });
    expect(r.success).toBe(true);
  });

  it('accepts notes', () => {
    const r = draftVersionSchema.safeParse({ ...baseDraft, notes: 'v1 release' });
    expect(r.success).toBe(true);
  });
});

describe('draftVersionSchema — vaultAppRoleRef on services', () => {
  const draftWithVaultAndRef = {
    networks: [],
    volumes: [],
    services: [{ ...baseService, vaultAppRoleRef: 'my-approle' }],
    vault: {
      policies: [{ name: 'my-policy', body: 'path "x" { capabilities = ["read"] }' }],
      appRoles: [{ name: 'my-approle', policy: 'my-policy' }],
    },
  };

  it('preserves vaultAppRoleRef on parsed services (regression: was silently stripped)', () => {
    const r = draftVersionSchema.safeParse(draftWithVaultAndRef);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.services[0].vaultAppRoleRef).toBe('my-approle');
    }
  });

  it('rejects vaultAppRoleRef pointing at an undeclared appRole', () => {
    const r = draftVersionSchema.safeParse({
      ...draftWithVaultAndRef,
      services: [{ ...baseService, vaultAppRoleRef: 'nonexistent-role' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('nonexistent-role'))).toBe(true);
      expect(messages.some((m) => m.includes("Service 'web'"))).toBe(true);
    }
  });

  it('rejects vaultAppRoleRef when the draft has no vault section at all', () => {
    const r = draftVersionSchema.safeParse({
      networks: [],
      volumes: [],
      services: [{ ...baseService, vaultAppRoleRef: 'my-approle' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('none defined'))).toBe(true);
    }
  });
});

describe('config-file mountPath safety', () => {
  const configFile = {
    serviceName: 'web',
    fileName: 'nginx.conf',
    volumeName: 'cfg',
    content: '',
  };

  it('accepts absolute paths', () => {
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      configFiles: [{ ...configFile, mountPath: '/etc/nginx/nginx.conf' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects relative paths with traversal', () => {
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      configFiles: [{ ...configFile, mountPath: '../../etc/passwd' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects paths missing a leading slash', () => {
    const r = createTemplateSchema.safeParse({
      ...baseCreate,
      configFiles: [{ ...configFile, mountPath: 'etc/nginx.conf' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('numberOrTemplate — {{params.*}} references', () => {
  const svcWithPort = (hostPort: unknown) => ({
    ...baseService,
    containerConfig: {
      ports: [{ containerPort: 80, hostPort, protocol: 'tcp' }],
    },
  });

  it('accepts a literal integer', () => {
    const r = stackServiceDefinitionSchema.safeParse(svcWithPort(8080));
    expect(r.success).toBe(true);
  });

  it('accepts a plain {{params.foo}} reference', () => {
    const r = stackServiceDefinitionSchema.safeParse(svcWithPort('{{params.port}}'));
    expect(r.success).toBe(true);
  });

  it('rejects a concatenated template string', () => {
    const r = stackServiceDefinitionSchema.safeParse(svcWithPort('80; {{params.port}}'));
    expect(r.success).toBe(false);
  });

  it('rejects two template references in one field', () => {
    const r = stackServiceDefinitionSchema.safeParse(svcWithPort('{{params.a}}{{params.b}}'));
    expect(r.success).toBe(false);
  });

  it('rejects non-params scopes like {{env.X}}', () => {
    const r = stackServiceDefinitionSchema.safeParse(svcWithPort('{{env.SECRET}}'));
    expect(r.success).toBe(false);
  });

  it('rejects trailing text after a reference', () => {
    const r = stackServiceDefinitionSchema.safeParse(svcWithPort('{{params.port}} extra'));
    expect(r.success).toBe(false);
  });
});
