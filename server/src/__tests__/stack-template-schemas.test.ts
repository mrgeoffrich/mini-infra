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
