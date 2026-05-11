import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TAILSCALE_CONTROL_PLANE_HOSTNAMES,
  TAILSCALE_DEFAULT_TAG,
  type StackServiceDefinition,
} from '@mini-infra/types';

// The claude-shell addon's `provision()` reads the optional git deploy key
// from Vault KV (Phase 5). Stub `getVaultKVService()` so the tests don't
// require a live Vault — the default stub returns `null` ("no key set"),
// and individual tests override `mockKvRead` to simulate a present key.
const mockKvRead = vi.fn();
vi.mock('../../vault/vault-kv-service', async () => {
  const paths = await vi.importActual<
    typeof import('../../vault/vault-kv-paths')
  >('../../vault/vault-kv-paths');
  return {
    KV_MOUNT: paths.KV_MOUNT,
    VaultKVError: paths.VaultKVError,
    validateKvPath: paths.validateKvPath,
    validateKvFieldName: paths.validateKvFieldName,
    getVaultKVService: () => ({ read: mockKvRead }),
  };
});

beforeEach(() => {
  mockKvRead.mockReset();
  // Default: no git-deploy-key configured for any stack/service.
  mockKvRead.mockResolvedValue(null);
});

// Imports below MUST come after the vi.mock so the stub is in place when the
// addon module evaluates its import of `getVaultKVService`.
import { createAddonRegistry } from '../registry';
import { expandAddons } from '../expand-addons';
import { claudeShellAddon } from '../claude-shell';

/**
 * Phase 3 of the claude-shell plan — the `claude-shell` env-injection addon.
 *
 * These tests pin the addon's contract end-to-end through `expandAddons`:
 *   - Manifest declares `mode: 'env-injection'`, `kind: 'claude-shell'`,
 *     `appliesTo: ['Stateful', 'StatelessWeb']`, and
 *     `requiresConnectedService: 'tailscale'`.
 *   - Config schema accepts an empty object, optional `gitRepo`, and optional
 *     `extraTags`; rejects unknown keys and malformed tags.
 *   - Expansion: mints an authkey, computes the `{stack}-{service}-{env}`
 *     hostname, and injects `TS_AUTHKEY` / `TS_HOSTNAME` / `TS_EXTRA_ARGS` /
 *     `TS_STATE_DIR` plus (optionally) `GIT_REPO_URL` onto the target's
 *     `containerConfig.env`.
 *   - Caps + devices: `NET_ADMIN` + `SYS_MODULE` and `/dev/net/tun` land on
 *     the target so the in-process tailscaled can bring up kernel-mode
 *     networking.
 *   - Required egress: Tailscale control-plane hostnames merged onto the
 *     target so the env's egress-firewall reconciler picks them up.
 *   - No synthetic sidecar — env-injection mode does not materialise one.
 */

const baseContext = {
  stack: { id: 'stack-1', name: 'shop' },
  environment: { id: 'env-1', name: 'prod', networkType: 'local' as const },
};

function makeStateful(
  name: string,
  overrides: Partial<StackServiceDefinition> = {},
): StackServiceDefinition {
  return {
    serviceName: name,
    serviceType: 'Stateful',
    dockerImage: 'ghcr.io/mrgeoffrich/mini-infra-claude-shell',
    dockerTag: 'dev',
    dependsOn: [],
    order: 1,
    containerConfig: { env: {}, restartPolicy: 'unless-stopped' },
    ...overrides,
  };
}

/**
 * Stub Tailscale connected service implementing the methods the addon's
 * provision path exercises through `TailscaleAuthkeyMinter`:
 *   - getAccessToken(): Promise<string>
 *   - getAllManagedTags(): Promise<string[]>
 *   - purgeStaleManagedDevicesByHostname(host): Promise<{deleted,errors}>
 */
function makeStubTailscaleService(): unknown {
  return {
    getAccessToken: async () => 'stub-access-token',
    getAllManagedTags: async () => [TAILSCALE_DEFAULT_TAG],
    purgeStaleManagedDevicesByHostname: async () => ({ deleted: 0, errors: 0 }),
  };
}

/**
 * Stub the global fetch for the duration of a test so the
 * `TailscaleAuthkeyMinter` POST returns a fake authkey response. Same shape
 * `tailscale-ssh`'s test uses.
 */
function withStubbedFetch<T>(
  fn: () => Promise<T>,
  authkey = 'tskey-auth-claude-shell-stub',
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

describe('claude-shell addon — manifest', () => {
  it('declares the contract the framework expects', () => {
    const m = claudeShellAddon.manifest;
    expect(m.id).toBe('claude-shell');
    expect(m.kind).toBe('claude-shell');
    expect(m.mode).toBe('env-injection');
    expect(m.requiresConnectedService).toBe('tailscale');
    expect(m.appliesTo).toEqual(
      expect.arrayContaining(['Stateful', 'StatelessWeb']),
    );
    // Pool is deliberately excluded — pool instances would need per-instance
    // hostnames, which is `tailscale-ssh`'s job, not this addon's.
    expect(m.appliesTo).not.toContain('Pool');
  });

  it('accepts the minimum-viable empty config', () => {
    expect(claudeShellAddon.configSchema.safeParse({}).success).toBe(true);
  });

  it('accepts an optional gitRepo URL', () => {
    expect(
      claudeShellAddon.configSchema.safeParse({
        gitRepo: 'https://github.com/example/repo.git',
      }).success,
    ).toBe(true);
  });

  it('accepts optional extraTags following the tag:[a-z0-9-]+ shape', () => {
    expect(
      claudeShellAddon.configSchema.safeParse({
        extraTags: ['tag:dev-team', 'tag:research'],
      }).success,
    ).toBe(true);
  });

  it('rejects unknown config keys via the strict zod schema', () => {
    expect(
      claudeShellAddon.configSchema.safeParse({ unknown: true }).success,
    ).toBe(false);
  });

  it('rejects extraTags that violate the tag:[a-z0-9-]+ shape', () => {
    expect(
      claudeShellAddon.configSchema.safeParse({ extraTags: ['no-prefix'] })
        .success,
    ).toBe(false);
    expect(
      claudeShellAddon.configSchema.safeParse({ extraTags: ['Tag:Bad'] })
        .success,
    ).toBe(false);
  });

  it('rejects an empty-string gitRepo (treat absence as "no clone")', () => {
    expect(
      claudeShellAddon.configSchema.safeParse({ gitRepo: '' }).success,
    ).toBe(false);
  });
});

describe('claude-shell addon — expansion', () => {
  it('injects TS_AUTHKEY / TS_HOSTNAME / TS_EXTRA_ARGS / TS_STATE_DIR onto the target', async () => {
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    // No synthetic sidecar — env-injection mode merges onto the target.
    expect(rendered).toHaveLength(1);
    const renderedTarget = rendered[0];
    expect(renderedTarget.serviceName).toBe('shell');
    expect(renderedTarget.synthetic).toBeUndefined();

    expect(renderedTarget.containerConfig.env).toMatchObject({
      TS_AUTHKEY: 'tskey-auth-claude-shell-stub',
      TS_HOSTNAME: 'shop-shell-prod',
      TS_EXTRA_ARGS: '--ssh',
      TS_STATE_DIR: '/var/lib/tailscale',
    });
    // GIT_REPO_URL is absent when no `gitRepo` was supplied in the addon
    // config — keeping the env stable across provision calls helps the
    // definition-hash stay deterministic.
    expect(renderedTarget.containerConfig.env).not.toHaveProperty(
      'GIT_REPO_URL',
    );
  });

  it('injects GIT_REPO_URL when the addon config supplies gitRepo', async () => {
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: {
        'claude-shell': { gitRepo: 'https://github.com/example/repo.git' },
      },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered[0].containerConfig.env?.GIT_REPO_URL).toBe(
      'https://github.com/example/repo.git',
    );
  });

  it('does NOT inject GIT_SSH_KEY when no Vault deploy-key path is present', async () => {
    // Phase 5: the addon reads from Vault KV at provision time. When the
    // path is absent the entrypoint's `[[ -n "${GIT_SSH_KEY:-}" ]]` guard
    // skips writing the key — anonymous clones still work for public repos.
    mockKvRead.mockResolvedValue(null);

    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered[0].containerConfig.env).not.toHaveProperty('GIT_SSH_KEY');
    expect(mockKvRead).toHaveBeenCalledWith(
      'stacks/stack-1/services/shell/git-deploy-key',
    );
  });

  it('injects GIT_SSH_KEY when the Vault deploy-key path holds a privateKey', async () => {
    // Phase 5: the addon reads the convention path
    // `stacks/${stackId}/services/${serviceName}/git-deploy-key` and emits
    // the `privateKey` field as `GIT_SSH_KEY`. The actual key material is
    // opaque to the addon — we use a clearly-fake marker so the test never
    // accidentally hard-codes a real private key.
    const FAKE_PEM_MARKER = 'TEST_FAKE_PEM_DO_NOT_USE_AS_REAL_KEY';
    mockKvRead.mockResolvedValue({ privateKey: FAKE_PEM_MARKER });

    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: {
        'claude-shell': { gitRepo: 'git@github.com:example/private.git' },
      },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered[0].containerConfig.env?.GIT_SSH_KEY).toBe(FAKE_PEM_MARKER);
    expect(mockKvRead).toHaveBeenCalledWith(
      'stacks/stack-1/services/shell/git-deploy-key',
    );
  });

  it('does NOT inject GIT_SSH_KEY when the Vault path exists but privateKey field is missing', async () => {
    // Defensive: if some operator wrote the wrong field name we want to fail
    // closed (no env injection) rather than emit an empty `GIT_SSH_KEY`.
    mockKvRead.mockResolvedValue({ notTheRightField: 'oops' });

    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered[0].containerConfig.env).not.toHaveProperty('GIT_SSH_KEY');
  });

  it('does NOT inject GIT_SSH_KEY when the Vault path exists but privateKey is an empty string', async () => {
    mockKvRead.mockResolvedValue({ privateKey: '' });

    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered[0].containerConfig.env).not.toHaveProperty('GIT_SSH_KEY');
  });

  it('merges NET_ADMIN + SYS_MODULE capabilities onto the target', async () => {
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered[0].containerConfig.capAdd).toEqual(
      expect.arrayContaining(['NET_ADMIN', 'SYS_MODULE']),
    );
  });

  it('merges /dev/net/tun device onto the target', async () => {
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered[0].containerConfig.devices).toEqual(['/dev/net/tun']);
  });

  it('merges Tailscale control-plane requiredEgress onto the target', async () => {
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered[0].containerConfig.requiredEgress).toEqual(
      expect.arrayContaining([...TAILSCALE_CONTROL_PLANE_HOSTNAMES]),
    );
  });

  it('tags the target with mini-infra.addon: claude-shell for endpoint discovery', async () => {
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered[0].containerConfig.labels).toMatchObject({
      'mini-infra.addon': 'claude-shell',
      'mini-infra.synthetic': 'false',
    });
  });

  it('does NOT materialise a synthetic sidecar (env-injection mode)', async () => {
    // Pinned as a regression guard so a future refactor that accidentally
    // routes claude-shell through the sidecar path trips a clear failure.
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    const rendered = await withStubbedFetch(() =>
      expandAddons([target], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(rendered).toHaveLength(1);
    expect(rendered.find((s) => s.synthetic)).toBeUndefined();
    expect(rendered[0].serviceName).toBe('shell');
  });

  it('rejects expansion when the Tailscale connected service is missing', async () => {
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });

    // No `connectedServices` lookup → applicability check fires before the
    // provision call runs and surfaces a clear error.
    await expect(
      expandAddons([target], { ...baseContext, registry }),
    ).rejects.toThrow(/connected service/);
  });

  it('rejects expansion against a Pool service (manifest excludes Pool)', async () => {
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
      serviceType: 'Pool',
    });

    await expect(
      withStubbedFetch(() =>
        expandAddons([target], {
          ...baseContext,
          registry,
          connectedServices: { tailscale: makeStubTailscaleService() },
        }),
      ),
    ).rejects.toThrow(/does not apply to service type "Pool"/);
  });

  it('computes a stack-prefixed hostname so two stacks with the same (service, env) do not collide', async () => {
    const registry = createAddonRegistry();
    registry.register(claudeShellAddon);

    const shop = makeStateful('shell', { addons: { 'claude-shell': {} } });
    const blog = makeStateful('shell', { addons: { 'claude-shell': {} } });

    const renderedShop = await withStubbedFetch(() =>
      expandAddons([shop], {
        ...baseContext,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );
    const renderedBlog = await withStubbedFetch(() =>
      expandAddons([blog], {
        stack: { id: 'stack-2', name: 'blog' },
        environment: baseContext.environment,
        registry,
        connectedServices: { tailscale: makeStubTailscaleService() },
      }),
    );

    expect(renderedShop[0].containerConfig.env?.TS_HOSTNAME).toBe(
      'shop-shell-prod',
    );
    expect(renderedBlog[0].containerConfig.env?.TS_HOSTNAME).toBe(
      'blog-shell-prod',
    );
  });
});
