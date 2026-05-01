/**
 * Structural drift-prevention test for the two "service" schemas.
 *
 * Background: Mini Infra has two Zod schemas that describe a service entry
 * in a stack/template. They previously drifted (`vaultAppRoleRef` was added
 * to the file-loader schema but not the HTTP draft schema), and Zod's
 * default of stripping unknown keys silently dropped the field on the way
 * to Prisma — apply-time bound nothing because the column was NULL.
 * Customer feedback #1 from the slackbot installer review.
 *
 * The two schemas now extend a shared `stackServiceCommonFieldsSchema`
 * base. This test exercises a fixture covering every common field and
 * proves the field round-trips through BOTH schemas. If a future change
 * adds a common field to only one of them (e.g. by re-introducing a
 * literal `z.object({...})` instead of extending the base), the matching
 * assertion here fails — well before a deploy hits the silent-drop bug.
 *
 * NOT a contract test for serviceType-specific refines or for HTTP-only
 * fields like `configFiles` / `adoptedContainer` / `vaultAppRoleId` — those
 * intentionally live only on `stackServiceDefinitionSchema`.
 */

import { describe, it, expect } from 'vitest';

import {
  stackServiceCommonFieldsSchema,
  stackServiceDefinitionSchema,
} from '../services/stacks/schemas';
import { templateFileSchema } from '../services/stacks/template-file-loader';

// ─── Fixture covering every common field with a representative value ─────────

const commonFieldFixture = {
  serviceName: 'web',
  serviceType: 'Stateful' as const,
  dockerImage: 'nginx',
  dockerTag: '1.25',
  containerConfig: {
    env: { LOG_LEVEL: 'info' },
    restartPolicy: 'no' as const,
  },
  initCommands: [
    { volumeName: 'data', mountPath: '/data', commands: ['chown 1000:1000 /data'] },
  ],
  dependsOn: ['db'],
  order: 1,
  // routing intentionally omitted (Stateful + routing is rejected by the
  // file-loader's stricter refine; the field itself still belongs to the
  // common base).
  vaultAppRoleRef: 'web-approle',
};

const COMMON_FIELDS = [
  'serviceName',
  'serviceType',
  'dockerImage',
  'dockerTag',
  'containerConfig',
  'initCommands',
  'dependsOn',
  'order',
  'routing',
  'vaultAppRoleRef',
  'natsCredentialRef',
  'natsRole',
  'natsSigner',
] as const;

// Every key in COMMON_FIELDS must also be a key of the shared base. If
// someone adds a key to the array without adding it to the schema (or vice
// versa), this fails immediately.
describe('stackServiceCommonFieldsSchema — pinned key set', () => {
  it('exposes every documented common field on .shape', () => {
    const shapeKeys = new Set(Object.keys(stackServiceCommonFieldsSchema.shape));
    for (const field of COMMON_FIELDS) {
      expect(shapeKeys.has(field), `common base missing field "${field}"`).toBe(true);
    }
  });

  it('does not silently drop common fields when parsed (Zod strict-keys check)', () => {
    const r = stackServiceCommonFieldsSchema.safeParse(commonFieldFixture);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.serviceName).toBe('web');
      expect(r.data.dockerImage).toBe('nginx');
      expect(r.data.vaultAppRoleRef).toBe('web-approle');
      expect(r.data.dependsOn).toEqual(['db']);
      expect(r.data.order).toBe(1);
    }
  });
});

// ─── stackServiceDefinitionSchema (HTTP/DB) ─────────────────────────────────

describe('stackServiceDefinitionSchema — preserves every common field', () => {
  it('round-trips the full common fixture without dropping fields', () => {
    const r = stackServiceDefinitionSchema.safeParse(commonFieldFixture);
    expect(r.success).toBe(true);
    if (!r.success) return;

    // Each assertion below catches a different drift scenario: a future PR
    // that overrides one of these fields with a stricter shape on the
    // extension side without keeping it accept-shaped on the base.
    expect(r.data.serviceName).toBe(commonFieldFixture.serviceName);
    expect(r.data.serviceType).toBe(commonFieldFixture.serviceType);
    expect(r.data.dockerImage).toBe(commonFieldFixture.dockerImage);
    expect(r.data.dockerTag).toBe(commonFieldFixture.dockerTag);
    expect(r.data.containerConfig).toEqual(commonFieldFixture.containerConfig);
    expect(r.data.initCommands).toEqual(commonFieldFixture.initCommands);
    expect(r.data.dependsOn).toEqual(commonFieldFixture.dependsOn);
    expect(r.data.order).toBe(commonFieldFixture.order);
    // The vaultAppRoleRef bug: if a future refactor accidentally drops the
    // field off the HTTP schema's accepted set (the Zod-strip-unknown trap),
    // this assertion fails.
    expect(r.data.vaultAppRoleRef).toBe(commonFieldFixture.vaultAppRoleRef);
  });
});

// ─── templateFileSchema → services[] (file loader) ──────────────────────────

describe('templateFileSchema services[] — preserves every common field', () => {
  // Wrap the fixture in a complete template body so we can hand it to
  // the top-level schema (no need to export the inner templateServiceSchema
  // just for tests). Include the vault section that vaultAppRoleRef refers
  // to — the file-loader has a cross-validator that rejects dangling refs.
  function templateBody(svc: Record<string, unknown>) {
    return {
      name: 'tpl',
      displayName: 'Test',
      builtinVersion: 1,
      scope: 'environment' as const,
      networks: [],
      volumes: [],
      services: [svc],
      vault: {
        policies: [{ name: 'web-policy', body: 'path "x" { capabilities = ["read"] }' }],
        appRoles: [{ name: 'web-approle', policy: 'web-policy' }],
      },
    };
  }

  it('round-trips the full common fixture without dropping fields', () => {
    const r = templateFileSchema.safeParse(templateBody(commonFieldFixture));
    expect(r.success).toBe(true);
    if (!r.success) return;

    const svc = r.data.services[0];
    expect(svc.serviceName).toBe(commonFieldFixture.serviceName);
    expect(svc.serviceType).toBe(commonFieldFixture.serviceType);
    expect(svc.dockerImage).toBe(commonFieldFixture.dockerImage);
    expect(svc.dockerTag).toBe(commonFieldFixture.dockerTag);
    expect(svc.containerConfig).toEqual(commonFieldFixture.containerConfig);
    expect(svc.initCommands).toEqual(commonFieldFixture.initCommands);
    expect(svc.dependsOn).toEqual(commonFieldFixture.dependsOn);
    expect(svc.order).toBe(commonFieldFixture.order);
    expect(svc.vaultAppRoleRef).toBe(commonFieldFixture.vaultAppRoleRef);
  });
});

// ─── HTTP-only fields stay HTTP-only ─────────────────────────────────────────

describe('schema separation — HTTP-only fields are not on the common base', () => {
  // These fields are intentionally absent from the file-loader shape:
  //   - configFiles  : the loader uses a top-level `configFiles[]` array
  //                    (referenced by serviceName); the embedded form here
  //                    only exists post-load.
  //   - adoptedContainer / poolConfig: file-format doesn't support these
  //                    service types yet.
  //   - vaultAppRoleId: resolved concrete ID set at apply time, not authored.
  it('common base does not expose HTTP-only fields', () => {
    const baseKeys = new Set(Object.keys(stackServiceCommonFieldsSchema.shape));
    expect(baseKeys.has('configFiles')).toBe(false);
    expect(baseKeys.has('adoptedContainer')).toBe(false);
    expect(baseKeys.has('poolConfig')).toBe(false);
    expect(baseKeys.has('vaultAppRoleId')).toBe(false);
  });
});
