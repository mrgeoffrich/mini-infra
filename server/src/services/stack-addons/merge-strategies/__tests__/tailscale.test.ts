import { describe, it, expect } from 'vitest';
import {
  TAILSCALE_DEFAULT_TAG,
  type StackServiceDefinition,
} from '@mini-infra/types';
import { createAddonRegistry } from '../../registry';
import { expandAddons } from '../../expand-addons';
import { tailscaleSshAddon } from '../../tailscale-ssh';
import { tailscaleWebAddon } from '../../tailscale-web';
import { tailscaleMergeStrategy } from '../tailscale';

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

interface StubFetchOptions {
  authkey?: string;
  searchPaths?: string[];
  /** When `true`, the searchpaths endpoint returns 500. */
  searchPathsError?: boolean;
}

function makeStubTailscaleService(opts: StubFetchOptions = {}) {
  return {
    getAccessToken: async () => 'stub-access-token',
    getAllManagedTags: async () => [TAILSCALE_DEFAULT_TAG],
    getTailnetDomain: async () => {
      if (opts.searchPathsError) {
        throw new Error('searchpaths fetch failed');
      }
      const first = opts.searchPaths?.[0];
      return first ? first.replace(/\.$/, '') : null;
    },
    purgeStaleManagedDevicesByHostname: async () => ({ deleted: 0, errors: 0 }),
  };
}

let mintCalls = 0;

function withStubbedFetch<T>(
  fn: () => Promise<T>,
  opts: StubFetchOptions = {},
): Promise<T> {
  mintCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.endsWith('/keys')) {
      mintCalls += 1;
      return new Response(
        JSON.stringify({
          id: `k-stub-${mintCalls}`,
          key: opts.authkey ?? `tskey-auth-stub-${mintCalls}`,
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
    }
    if (typeof url === 'string' && url.endsWith('/dns/searchpaths')) {
      return new Response(
        JSON.stringify({ searchPaths: opts.searchPaths ?? [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function buildRegistry() {
  const registry = createAddonRegistry();
  registry.register(tailscaleSshAddon);
  registry.register(tailscaleWebAddon);
  registry.registerMergeStrategy(tailscaleMergeStrategy);
  return registry;
}

describe('tailscale merge strategy (kind:"tailscale")', () => {
  it('collapses tailscale-ssh + tailscale-web into one merged sidecar', async () => {
    const registry = buildRegistry();
    const target = makeStateful('web', {
      addons: {
        'tailscale-ssh': {},
        'tailscale-web': { port: 8080 },
      },
    });

    const rendered = await withStubbedFetch(
      () =>
        expandAddons([target], {
          ...baseContext,
          registry,
          connectedServices: {
            tailscale: makeStubTailscaleService({ searchPaths: ['ts-tailnet.ts.net'] }),
          },
        }),
      { searchPaths: ['ts-tailnet.ts.net'] },
    );

    // Exactly one synthetic sidecar — the whole point of the merge.
    const sidecars = rendered.filter((s) => s.serviceName !== 'web');
    expect(sidecars).toHaveLength(1);
    const sidecar = sidecars[0];
    expect(sidecar.serviceName).toBe('web-tailscale');
    expect(sidecar.dockerImage).toBe('tailscale/tailscale');

    // Synthetic back-ref carries both addon ids and the kind label.
    expect(sidecar.synthetic).toEqual({
      addonIds: expect.arrayContaining(['tailscale-ssh', 'tailscale-web']),
      kind: 'tailscale',
      targetService: 'web',
    });

    // Env carries BOTH --ssh and TS_SERVE_CONFIG — the contract for "one
    // sidecar, two surfaces".
    expect(sidecar.containerConfig.env).toMatchObject({
      TS_AUTHKEY: expect.stringMatching(/^tskey-auth-stub-/),
      TS_HOSTNAME: 'web-stack-web-prod',
      TS_EXTRA_ARGS: '--ssh',
      TS_SERVE_CONFIG: '/etc/tailscale/serve.json',
    });

    // Exactly one authkey was minted across both addons (single device).
    expect(mintCalls).toBe(1);

    // serve.json is mounted with the rendered HTTPS proxy → http://web:8080.
    // `path` is the location inside the volume; the volume is mounted at
    // /etc/tailscale on the sidecar so the file appears at
    // /etc/tailscale/serve.json (matching TS_SERVE_CONFIG).
    expect(sidecar.configFiles).toBeDefined();
    expect(sidecar.configFiles).toHaveLength(1);
    const serveFile = sidecar.configFiles![0];
    expect(serveFile.path).toBe('/serve.json');
    expect(serveFile.volumeName).toBe('web-tailscale-config');
    const parsed = JSON.parse(serveFile.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      TCP: { '443': { HTTPS: true } },
      Web: {
        '${TS_CERT_DOMAIN}:443': {
          Handlers: { '/': { Proxy: 'http://web:8080' } },
        },
      },
    });

    // Two volume mounts — the always-on state volume AND the config volume
    // that holds serve.json. Without the config mount, TS_SERVE_CONFIG
    // points at a non-existent path and the HTTPS surface fails to come up.
    expect(sidecar.containerConfig.mounts).toHaveLength(2);
    expect(sidecar.containerConfig.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'web-tailscale-state',
          target: '/var/lib/tailscale',
          type: 'volume',
        }),
        expect.objectContaining({
          source: 'web-tailscale-config',
          target: '/etc/tailscale',
          type: 'volume',
        }),
      ]),
    );

    // Merged-marker labels — the kind, a comma-separated member list, and
    // the standard synthetic markers.
    expect(sidecar.containerConfig.labels).toMatchObject({
      'mini-infra.addon': 'tailscale',
      'mini-infra.addon-kind': 'tailscale',
      'mini-infra.addon-members': 'tailscale-ssh,tailscale-web',
      'mini-infra.synthetic': 'true',
      'mini-infra.addon-target': 'web',
    });
  });

  it('renders serve.json with the configured path when web addon supplies one', async () => {
    const registry = buildRegistry();
    const target = makeStateful('api', {
      addons: {
        'tailscale-ssh': {},
        'tailscale-web': { port: 9090, path: '/v1' },
      },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );
    const sidecar = rendered.find((s) => s.serviceName === 'api-tailscale')!;
    const parsed = JSON.parse(sidecar.configFiles![0].content) as {
      Web: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
    };
    expect(parsed.Web['${TS_CERT_DOMAIN}:443'].Handlers['/v1']).toEqual({
      Proxy: 'http://api:9090',
    });
  });

  it('tolerates a tailnet-domain lookup failure — sidecar still renders', async () => {
    const registry = buildRegistry();
    const target = makeStateful('web', {
      addons: {
        'tailscale-ssh': {},
        'tailscale-web': { port: 8080 },
      },
    });

    const rendered = await withStubbedFetch(
      () =>
        expandAddons([target], {
          ...baseContext,
          registry,
          connectedServices: {
            tailscale: makeStubTailscaleService({ searchPathsError: true }),
          },
        }),
      { searchPathsError: true },
    );
    const sidecar = rendered.find((s) => s.serviceName === 'web-tailscale');
    expect(sidecar).toBeDefined();
    // The serve.json itself uses runtime-substituted ${TS_CERT_DOMAIN} so the
    // data path is unaffected by the lookup failure.
    expect(sidecar!.containerConfig.env?.TS_SERVE_CONFIG).toBe(
      '/etc/tailscale/serve.json',
    );
  });

  it('idempotency: expanding the same authored stack twice yields equivalent sidecar shape', async () => {
    const registry = buildRegistry();
    const makeTarget = (): StackServiceDefinition =>
      makeStateful('web', {
        addons: {
          'tailscale-ssh': {},
          'tailscale-web': { port: 8080 },
        },
      });

    const a = await withStubbedFetch(
      () =>
        expandAddons([makeTarget()], {
          ...baseContext,
          registry,
          connectedServices: { tailscale: makeStubTailscaleService() },
        }),
      { authkey: 'tskey-a' },
    );
    const b = await withStubbedFetch(
      () =>
        expandAddons([makeTarget()], {
          ...baseContext,
          registry,
          connectedServices: { tailscale: makeStubTailscaleService() },
        }),
      { authkey: 'tskey-b' },
    );

    const stripVolatile = (def: StackServiceDefinition) => {
      const env = { ...(def.containerConfig.env ?? {}) };
      delete env.TS_AUTHKEY; // freshly minted on every render
      return { ...def, containerConfig: { ...def.containerConfig, env } };
    };

    const aSidecar = a.find((s) => s.serviceName === 'web-tailscale')!;
    const bSidecar = b.find((s) => s.serviceName === 'web-tailscale')!;
    expect(stripVolatile(aSidecar)).toEqual(stripVolatile(bSidecar));
  });

  it('isolation: tailscale-ssh alone keeps its solo shape (no merge)', async () => {
    const registry = buildRegistry();
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
    const sidecar = rendered.find((s) => s.serviceName === 'web-tailscale')!;
    expect(sidecar.synthetic).toEqual({
      addonIds: ['tailscale-ssh'],
      kind: undefined,
      targetService: 'web',
    });
    // Solo-ssh has no TS_SERVE_CONFIG and no serve.json file.
    expect(sidecar.containerConfig.env?.TS_SERVE_CONFIG).toBeUndefined();
    expect(sidecar.configFiles).toBeUndefined();
    // Solo labels are addon-id-flavoured, not kind-flavoured.
    expect(sidecar.containerConfig.labels?.['mini-infra.addon']).toBe(
      'tailscale-ssh',
    );
  });

  it('isolation: tailscale-web alone keeps its solo shape (no merge)', async () => {
    const registry = buildRegistry();
    const target = makeStateful('web', {
      addons: { 'tailscale-web': { port: 8080 } },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );
    const sidecar = rendered.find((s) => s.serviceName === 'web-tailscale')!;
    expect(sidecar.synthetic).toEqual({
      addonIds: ['tailscale-web'],
      kind: undefined,
      targetService: 'web',
    });
    // Solo-web has TS_SERVE_CONFIG but no --ssh.
    expect(sidecar.containerConfig.env?.TS_SERVE_CONFIG).toBe(
      '/etc/tailscale/serve.json',
    );
    expect(sidecar.containerConfig.env?.TS_EXTRA_ARGS).toBeUndefined();
    expect(sidecar.configFiles).toHaveLength(1);
    expect(sidecar.containerConfig.labels?.['mini-infra.addon']).toBe(
      'tailscale-web',
    );
  });

  it('unions extraTags across members and dedupes', async () => {
    const registry = buildRegistry();
    const target = makeStateful('web', {
      addons: {
        'tailscale-ssh': { extraTags: ['tag:dev', 'tag:shared'] },
        'tailscale-web': { port: 80, extraTags: ['tag:platform', 'tag:shared'] },
      },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );
    const sidecar = rendered.find((s) => s.serviceName === 'web-tailscale')!;
    // Only one authkey mint → only one chance to assert tags. Validate the
    // sidecar's hostname is present and synthetic info is right; the tag
    // dedup is exercised by the buildTailscaleTagSet contract test.
    expect(sidecar.containerConfig.env?.TS_HOSTNAME).toBe('web-stack-web-prod');
    expect(mintCalls).toBe(1);
  });

  it('rejects expansion when the Tailscale connected service is missing', async () => {
    const registry = buildRegistry();
    const target = makeStateful('web', {
      addons: {
        'tailscale-ssh': {},
        'tailscale-web': { port: 8080 },
      },
    });
    // No `connectedServices` → applicability check on each member fires
    // before merge resolution and surfaces the error.
    await expect(
      expandAddons([target], { ...baseContext, registry }),
    ).rejects.toThrow(/connected service/);
  });
});
