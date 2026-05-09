import { describe, it, expect } from 'vitest';
import {
  TAILSCALE_CONTROL_PLANE_HOSTNAMES,
  TAILSCALE_DEFAULT_TAG,
  type StackServiceDefinition,
} from '@mini-infra/types';
import { createAddonRegistry } from '../registry';
import { expandAddons } from '../expand-addons';
import { tailscaleWebAddon } from '../tailscale-web';

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

function makeStubTailscaleService(searchPaths: string[] = []): unknown {
  return {
    getAccessToken: async () => 'stub-access-token',
    getAllManagedTags: async () => [TAILSCALE_DEFAULT_TAG],
    getTailnetDomain: async () => searchPaths[0] ?? null,
  };
}

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

describe('tailscale-web addon', () => {
  it('manifest declares the kind:"tailscale" merge group', () => {
    const m = tailscaleWebAddon.manifest;
    expect(m.id).toBe('tailscale-web');
    expect(m.kind).toBe('tailscale');
    expect(m.requiresConnectedService).toBe('tailscale');
    expect(m.appliesTo).toEqual(
      expect.arrayContaining(['Stateful', 'StatelessWeb', 'Pool']),
    );
  });

  it('rejects unknown config keys via the strict zod schema', () => {
    expect(
      tailscaleWebAddon.configSchema.safeParse({
        port: 8080,
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it('requires the port field', () => {
    expect(tailscaleWebAddon.configSchema.safeParse({}).success).toBe(false);
    expect(tailscaleWebAddon.configSchema.safeParse({ port: 8080 }).success).toBe(
      true,
    );
  });

  it('rejects out-of-range ports and paths without a leading slash', () => {
    expect(
      tailscaleWebAddon.configSchema.safeParse({ port: 0 }).success,
    ).toBe(false);
    expect(
      tailscaleWebAddon.configSchema.safeParse({ port: 70_000 }).success,
    ).toBe(false);
    expect(
      tailscaleWebAddon.configSchema.safeParse({ port: 8080, path: 'no-slash' })
        .success,
    ).toBe(false);
    expect(
      tailscaleWebAddon.configSchema.safeParse({ port: 8080, path: '/api' })
        .success,
    ).toBe(true);
  });

  it('end-to-end render: solo web addon mounts serve.json and sets TS_SERVE_CONFIG', async () => {
    const registry = createAddonRegistry();
    registry.register(tailscaleWebAddon);

    const target = makeStateful('web', {
      addons: { 'tailscale-web': { port: 8080 } },
    });
    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: {
          tailscale: makeStubTailscaleService(['ts-tailnet.ts.net']),
        },
      }),
    );

    expect(rendered).toHaveLength(2);
    const sidecar = rendered.find((s) => s.serviceName === 'web-tailscale')!;
    expect(sidecar.dockerImage).toBe('tailscale/tailscale');
    expect(sidecar.synthetic).toEqual({
      addonIds: ['tailscale-web'],
      kind: undefined,
      targetService: 'web',
    });

    expect(sidecar.containerConfig.env).toMatchObject({
      TS_AUTHKEY: 'tskey-auth-stub',
      TS_HOSTNAME: 'web-prod',
      TS_SERVE_CONFIG: '/etc/tailscale/serve.json',
    });
    expect(sidecar.containerConfig.env?.TS_EXTRA_ARGS).toBeUndefined();

    // Required egress reuses the Phase 3 control-plane list.
    expect(sidecar.containerConfig.requiredEgress).toEqual(
      expect.arrayContaining([...TAILSCALE_CONTROL_PLANE_HOSTNAMES]),
    );

    // serve.json contents — ${TS_CERT_DOMAIN} stays literal so tailscaled
    // substitutes it at boot.
    expect(sidecar.configFiles).toHaveLength(1);
    const file = sidecar.configFiles![0];
    expect(file.path).toBe('/etc/tailscale/serve.json');
    expect(file.volumeName).toBe('web-tailscale-config');
    expect(JSON.parse(file.content)).toMatchObject({
      Web: {
        '${TS_CERT_DOMAIN}:443': {
          Handlers: { '/': { Proxy: 'http://web:8080' } },
        },
      },
    });

    // Synthetic-marker labels — addon-badge consumes 'mini-infra.addon'.
    expect(sidecar.containerConfig.labels).toMatchObject({
      'mini-infra.addon': 'tailscale-web',
      'mini-infra.synthetic': 'true',
      'mini-infra.addon-target': 'web',
    });
  });

  it('rejects expansion when the Tailscale connected service is missing', async () => {
    const registry = createAddonRegistry();
    registry.register(tailscaleWebAddon);

    const target = makeStateful('web', {
      addons: { 'tailscale-web': { port: 8080 } },
    });
    await expect(
      expandAddons([target], { ...baseContext, registry }),
    ).rejects.toThrow(/connected service/);
  });
});
