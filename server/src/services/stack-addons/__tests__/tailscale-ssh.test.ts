import { describe, it, expect } from 'vitest';
import {
  TAILSCALE_CONTROL_PLANE_HOSTNAMES,
  TAILSCALE_DEFAULT_TAG,
  buildTailscaleTagSet,
  sanitizeTailscaleHostname,
  type ProvisionContext,
  type StackServiceDefinition,
} from '@mini-infra/types';
import { createAddonRegistry } from '../registry';
import { expandAddons } from '../expand-addons';
import { tailscaleSshAddon } from '../tailscale-ssh';

const baseContext = {
  stack: { id: 'stack-1', name: 'web-stack' },
  environment: { id: 'env-1', name: 'prod', networkType: 'local' as const },
};

function makeStateful(
  name: string,
  overrides: Partial<StackServiceDefinition> = {},
): StackServiceDefinition {
  return {
    serviceName: name,
    serviceType: 'Stateful',
    dockerImage: 'nginx',
    dockerTag: 'latest',
    dependsOn: [],
    order: 1,
    containerConfig: { env: {}, restartPolicy: 'unless-stopped' },
    ...overrides,
  };
}

/**
 * Stub Tailscale connected service implementing only the `mintAuthkey`
 * method the addon exercises through `TailscaleAuthkeyMinter`. We replace
 * the minter's fetch via duck-typed substitution at construction time —
 * see how the addon imports it. For the unit test we instead stub the
 * connectedServices lookup with an object whose minter behaviour we
 * control.
 */
function makeStubTailscaleService(): unknown {
  // Minimal duck-typed shape covering the calls TailscaleAuthkeyMinter
  // makes against the real TailscaleService:
  //   - getAccessToken(): Promise<string>
  //   - getAllManagedTags(): Promise<string[]>
  return {
    getAccessToken: async () => 'stub-access-token',
    getAllManagedTags: async () => [TAILSCALE_DEFAULT_TAG],
  };
}

/**
 * Stub the global fetch for the duration of a test so the
 * `TailscaleAuthkeyMinter` POST returns a fake authkey response. The minter
 * calls `fetch(url, { method: 'POST', ... })` against
 * `https://api.tailscale.com/api/v2/tailnet/-/keys`.
 */
function withStubbedFetch<T>(
  fn: () => Promise<T>,
  authkey = 'tskey-auth-stub',
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        id: 'k-stub',
        key: authkey,
        created: '2026-01-01T00:00:00Z',
        expires: '2026-01-01T01:00:00Z',
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: true,
              preauthorized: true,
              tags: [TAILSCALE_DEFAULT_TAG],
            },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

describe('tailscale-ssh addon', () => {
  it('manifest declares the contract the framework expects', () => {
    const m = tailscaleSshAddon.manifest;
    expect(m.id).toBe('tailscale-ssh');
    expect(m.kind).toBe('tailscale');
    expect(m.requiresConnectedService).toBe('tailscale');
    expect(m.appliesTo).toEqual(
      expect.arrayContaining(['Stateful', 'StatelessWeb', 'Pool']),
    );
  });

  it('rejects unknown config keys via the strict zod schema', () => {
    const result = tailscaleSshAddon.configSchema.safeParse({ unknown: true });
    expect(result.success).toBe(false);
  });

  it('accepts an empty config and an explicit extraTags list', () => {
    expect(tailscaleSshAddon.configSchema.safeParse({}).success).toBe(true);
    expect(
      tailscaleSshAddon.configSchema.safeParse({
        extraTags: ['tag:dev', 'tag:platform'],
      }).success,
    ).toBe(true);
  });

  it('rejects extraTags that violate the tag:[a-z0-9-]+ shape', () => {
    expect(
      tailscaleSshAddon.configSchema.safeParse({ extraTags: ['no-prefix'] })
        .success,
    ).toBe(false);
    expect(
      tailscaleSshAddon.configSchema.safeParse({ extraTags: ['Tag:Bad'] })
        .success,
    ).toBe(false);
  });

  it('end-to-end render: expansion materialises the synthetic tailscaled sidecar', async () => {
    const registry = createAddonRegistry();
    registry.register(tailscaleSshAddon);

    const target = makeStateful('web', {
      addons: { 'tailscale-ssh': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered).toHaveLength(2);
    const sidecar = rendered.find((s) => s.serviceName === 'web-tailscale')!;
    expect(sidecar).toBeDefined();
    expect(sidecar.dockerImage).toBe('tailscale/tailscale');
    expect(sidecar.synthetic).toEqual({
      addonIds: ['tailscale-ssh'],
      kind: undefined,
      targetService: 'web',
    });
    // Authkey + hostname env are present and the hostname follows the
    // `<service>-<env>` rule.
    expect(sidecar.containerConfig.env).toMatchObject({
      TS_AUTHKEY: 'tskey-auth-stub',
      TS_HOSTNAME: 'web-prod',
      TS_EXTRA_ARGS: '--ssh',
    });
    // Required egress lists the Tailscale control-plane hostnames (§4.7
    // of the plan; firewalled-env smoke test).
    expect(sidecar.containerConfig.requiredEgress).toEqual(
      expect.arrayContaining([...TAILSCALE_CONTROL_PLANE_HOSTNAMES]),
    );
    // Synthetic-marker labels — the containers page reads these directly
    // to render the AddonBadge.
    expect(sidecar.containerConfig.labels).toMatchObject({
      'mini-infra.addon': 'tailscale-ssh',
      'mini-infra.synthetic': 'true',
      'mini-infra.addon-target': 'web',
    });
  });

  it('rejects expansion when the Tailscale connected service is missing', async () => {
    const registry = createAddonRegistry();
    registry.register(tailscaleSshAddon);

    const target = makeStateful('web', {
      addons: { 'tailscale-ssh': {} },
    });

    // No `connectedServices` lookup → applicability check fires before the
    // provision call runs and surfaces a clear error.
    await expect(
      expandAddons([target], { ...baseContext, registry }),
    ).rejects.toThrow(/connected service/);
  });

  it('build-service-definition is independent of the minted authkey value', () => {
    // Smoke: buildServiceDefinition is a pure function of (ctx, provisioned).
    // Pass the same shape twice with different authkeys and confirm only
    // env.TS_AUTHKEY differs.
    const def = tailscaleSshAddon.definition;
    const ctx: ProvisionContext = {
      stack: baseContext.stack,
      environment: baseContext.environment,
      service: { name: 'web', type: 'Stateful' },
      addonConfig: {},
      connectedServices: undefined,
    };
    const a = def.buildServiceDefinition(ctx, {
      envForSidecar: { TS_AUTHKEY: 'a', TS_HOSTNAME: 'web-prod' },
      templateVars: {},
    });
    const b = def.buildServiceDefinition(ctx, {
      envForSidecar: { TS_AUTHKEY: 'b', TS_HOSTNAME: 'web-prod' },
      templateVars: {},
    });
    expect({ ...a, containerConfig: { ...a.containerConfig, env: {} } })
      .toEqual({ ...b, containerConfig: { ...b.containerConfig, env: {} } });
    expect(a.containerConfig.env?.TS_AUTHKEY).toBe('a');
    expect(b.containerConfig.env?.TS_AUTHKEY).toBe('b');
  });
});

describe('lib/ helpers used by the tailscale-ssh addon', () => {
  it('buildTailscaleTagSet always includes the static default tag', () => {
    expect(buildTailscaleTagSet()).toEqual([TAILSCALE_DEFAULT_TAG]);
    expect(buildTailscaleTagSet([])).toEqual([TAILSCALE_DEFAULT_TAG]);
    expect(buildTailscaleTagSet(['tag:dev'])).toEqual([
      TAILSCALE_DEFAULT_TAG,
      'tag:dev',
    ]);
  });

  it('buildTailscaleTagSet dedupes and trims', () => {
    expect(
      buildTailscaleTagSet([
        TAILSCALE_DEFAULT_TAG,
        ' tag:dev ',
        'tag:dev',
        '',
      ]),
    ).toEqual([TAILSCALE_DEFAULT_TAG, 'tag:dev']);
  });

  it('sanitizeTailscaleHostname enforces the {service}-{env} ≤63 char rule', () => {
    expect(sanitizeTailscaleHostname('web', 'prod')).toBe('web-prod');
    expect(sanitizeTailscaleHostname('Web_App', 'PROD')).toBe('web-app-prod');
    expect(sanitizeTailscaleHostname('foo--bar', 'baz')).toBe('foo-bar-baz');
  });

  it('sanitizeTailscaleHostname truncates to ≤63 octets and trims trailing hyphens', () => {
    const long = sanitizeTailscaleHostname('a'.repeat(70), 'b');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).not.toMatch(/-$/);
  });

  it('sanitizeTailscaleHostname throws when no valid characters survive', () => {
    expect(() => sanitizeTailscaleHostname('___', '___')).toThrow();
  });
});
