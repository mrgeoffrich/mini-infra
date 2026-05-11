import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type {
  EnvInjectionAddonDefinition,
  EnvInjectionProvisionedValues,
  ProvisionContext,
  StackServiceDefinition,
} from '@mini-infra/types';
import { createAddonRegistry, type RegisteredAddon } from '../registry';
import { expandAddons, AddonExpansionError } from '../expand-addons';

/**
 * Phase 2 of the claude-shell plan — addon-framework env-injection mode.
 *
 * These tests pin the env-injection contract:
 *   1. A `mode: 'env-injection'` addon merges `envForTarget` / `mountsForTarget`
 *      / `labelsForTarget` / `requiredEgress` onto the target service.
 *   2. No synthetic sidecar is materialised — the rendered services list has
 *      exactly the same number of services as the authored list.
 *   3. The target carries a `mini-infra.addon: <addon-id>` label so the
 *      Phase-4 endpoint discovery can find env-injection addons without
 *      scanning manifests.
 *   4. Key collisions on `envForTarget` fail loudly rather than silently
 *      overwriting operator-authored env vars.
 *   5. `dryRun` mode tags the target with the addon-id label but skips
 *      side-effecting provisioning.
 */

const baseContext = {
  stack: { id: 'stack-test', name: 'test-stack' },
  environment: {
    id: 'env-test',
    name: 'dev',
    networkType: 'local' as const,
  },
};

function makeStateful(
  name: string,
  overrides: Partial<StackServiceDefinition> = {},
): StackServiceDefinition {
  return {
    serviceName: name,
    serviceType: 'Stateful',
    dockerImage: 'ghcr.io/mrgeoffrich/claude-shell',
    dockerTag: 'latest',
    dependsOn: [],
    order: 1,
    containerConfig: {
      env: { WORKSPACE_DIR: '/workspace' },
      restartPolicy: 'unless-stopped',
    },
    ...overrides,
  };
}

/**
 * Fixture env-injection addon — emits a fixed env/mount/label/egress payload
 * so the test can assert exact merge behaviour. Schemas accept an optional
 * `injectKey` to drive the collision-test variants from one fixture.
 */
const envInjectionConfigSchema = z
  .object({
    injectKey: z.string().min(1).max(64).optional(),
    injectValue: z.string().min(1).max(64).optional(),
  })
  .strict();

type EnvInjectionConfig = z.infer<typeof envInjectionConfigSchema>;

function makeFixtureAddon(opts: {
  id?: string;
  envForTarget?: Record<string, string>;
  mountsForTarget?: EnvInjectionProvisionedValues['mountsForTarget'];
  labelsForTarget?: Record<string, string>;
  requiredEgress?: string[];
  capAddForTarget?: string[];
  devicesForTarget?: string[];
} = {}): RegisteredAddon {
  const id = opts.id ?? 'fixture-env-injection';
  const definition: EnvInjectionAddonDefinition = {
    manifest: {
      id,
      mode: 'env-injection',
      description: 'Test fixture addon — env-injection mode.',
      appliesTo: ['Stateful', 'StatelessWeb', 'Pool'],
    },
    async provision(
      ctx: ProvisionContext,
    ): Promise<EnvInjectionProvisionedValues> {
      const config = ctx.addonConfig as EnvInjectionConfig;
      const envForTarget: Record<string, string> = {
        ...(opts.envForTarget ?? {}),
        ...(config.injectKey && config.injectValue
          ? { [config.injectKey]: config.injectValue }
          : {}),
      };
      return {
        mode: 'env-injection',
        envForTarget,
        mountsForTarget: opts.mountsForTarget,
        labelsForTarget: opts.labelsForTarget,
        requiredEgress: opts.requiredEgress,
        capAddForTarget: opts.capAddForTarget,
        devicesForTarget: opts.devicesForTarget,
      };
    },
  };
  return {
    manifest: definition.manifest,
    configSchema: envInjectionConfigSchema,
    definition,
  };
}

describe('expandAddons — env-injection mode', () => {
  it('merges envForTarget / mountsForTarget / labelsForTarget / requiredEgress onto the target', async () => {
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'claude-shell',
        envForTarget: {
          TS_AUTHKEY: 'tskey-stub',
          TS_HOSTNAME: 'test-stack-shell-dev',
          TS_EXTRA_ARGS: '--ssh',
        },
        mountsForTarget: [
          { source: 'workspace-vol', target: '/workspace', type: 'volume' },
        ],
        labelsForTarget: {
          'mini-infra.tailscale-managed': 'true',
        },
        requiredEgress: ['controlplane.tailscale.com', '*.derp.tailscale.com'],
      }),
    );

    const target = makeStateful('shell', {
      addons: { 'claude-shell': {} },
    });
    const rendered = await expandAddons([target], { ...baseContext, registry });

    // No synthetic sidecar — the rendered list has the same services as the
    // input.
    expect(rendered).toHaveLength(1);
    const renderedTarget = rendered[0];
    expect(renderedTarget.serviceName).toBe('shell');
    expect(renderedTarget.synthetic).toBeUndefined();

    // Env merged in. Original WORKSPACE_DIR preserved, addon keys added.
    expect(renderedTarget.containerConfig.env).toEqual({
      WORKSPACE_DIR: '/workspace',
      TS_AUTHKEY: 'tskey-stub',
      TS_HOSTNAME: 'test-stack-shell-dev',
      TS_EXTRA_ARGS: '--ssh',
    });

    // Mounts appended.
    expect(renderedTarget.containerConfig.mounts).toEqual([
      { source: 'workspace-vol', target: '/workspace', type: 'volume' },
    ]);

    // Labels merged with the always-on addon-id label (mini-infra.addon).
    expect(renderedTarget.containerConfig.labels).toMatchObject({
      'mini-infra.addon': 'claude-shell',
      'mini-infra.synthetic': 'false',
      'mini-infra.tailscale-managed': 'true',
    });

    // Egress hostnames merged.
    expect(renderedTarget.containerConfig.requiredEgress).toEqual([
      'controlplane.tailscale.com',
      '*.derp.tailscale.com',
    ]);
  });

  it('tags the target with mini-infra.addon: <id> even when no labelsForTarget are returned', async () => {
    // Phase 4's Connect-panel endpoint-discovery scans for this label. The
    // framework must apply it unconditionally — addons that don't return any
    // `labelsForTarget` of their own still get the discovery key.
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'discovery-only',
        envForTarget: { FOO: 'bar' },
      }),
    );

    const target = makeStateful('shell', { addons: { 'discovery-only': {} } });
    const rendered = await expandAddons([target], { ...baseContext, registry });

    expect(rendered).toHaveLength(1);
    expect(rendered[0].containerConfig.labels).toEqual({
      'mini-infra.addon': 'discovery-only',
      'mini-infra.synthetic': 'false',
    });
  });

  it('throws a clear AddonExpansionError on envForTarget key collision', async () => {
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'collider',
        envForTarget: { WORKSPACE_DIR: '/other' }, // collides with target env
      }),
    );

    const target = makeStateful('shell', { addons: { collider: {} } });
    await expect(
      expandAddons([target], { ...baseContext, registry }),
    ).rejects.toThrow(/cannot inject env var "WORKSPACE_DIR"/);
    await expect(
      expandAddons([target], { ...baseContext, registry }),
    ).rejects.toBeInstanceOf(AddonExpansionError);
  });

  it('preserves the authored target containerConfig fields that the addon does not touch', async () => {
    // The merge writes new env / mounts / labels / requiredEgress but must
    // leave restartPolicy, image, etc. untouched.
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'minimal',
        envForTarget: { FOO: 'bar' },
      }),
    );

    const target = makeStateful('shell', {
      addons: { minimal: {} },
    });
    const rendered = await expandAddons([target], { ...baseContext, registry });

    expect(rendered[0].containerConfig.restartPolicy).toBe('unless-stopped');
    expect(rendered[0].dockerImage).toBe('ghcr.io/mrgeoffrich/claude-shell');
    expect(rendered[0].dockerTag).toBe('latest');
  });

  it('does not materialise a synthetic service for an env-injection addon', async () => {
    // Pinned as a separate test so a future refactor that accidentally adds a
    // sidecar path for env-injection mode trips a clear failure.
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'no-sidecar',
        envForTarget: { FOO: 'bar' },
      }),
    );

    const target = makeStateful('shell', { addons: { 'no-sidecar': {} } });
    const rendered = await expandAddons([target], { ...baseContext, registry });

    expect(rendered).toHaveLength(1);
    expect(rendered.find((s) => s.synthetic)).toBeUndefined();
    expect(rendered.find((s) => s.serviceName !== 'shell')).toBeUndefined();
  });

  it('dedupes requiredEgress entries the target already declared', async () => {
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'shared-egress',
        envForTarget: { FOO: 'bar' },
        requiredEgress: ['github.com', 'controlplane.tailscale.com'],
      }),
    );

    const target = makeStateful('shell', {
      addons: { 'shared-egress': {} },
      containerConfig: {
        env: { WORKSPACE_DIR: '/workspace' },
        restartPolicy: 'unless-stopped',
        requiredEgress: ['github.com'], // overlaps with addon-supplied entry
      },
    });

    const rendered = await expandAddons([target], { ...baseContext, registry });
    expect(rendered[0].containerConfig.requiredEgress).toEqual(
      expect.arrayContaining(['github.com', 'controlplane.tailscale.com']),
    );
    // Deduplicated — exactly one github.com entry.
    expect(
      rendered[0].containerConfig.requiredEgress!.filter((e) => e === 'github.com'),
    ).toHaveLength(1);
  });

  it('fires onProvisioned with the target serviceName as the synthetic back-reference', async () => {
    // Env-injection addons don't materialise a synthetic, so the framework
    // surfaces the target name in the syntheticServiceName slot. This keeps
    // the progress callback shape stable for callers fanning out events.
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'progress-fixture',
        envForTarget: { FOO: 'bar' },
      }),
    );

    const target = makeStateful('shell', {
      addons: { 'progress-fixture': {} },
    });

    const events: Array<{
      serviceName: string;
      addonIds: string[];
      syntheticServiceName: string;
    }> = [];
    await expandAddons(
      [target],
      { ...baseContext, registry },
      {
        onProvisioned: (info) =>
          events.push({
            serviceName: info.serviceName,
            addonIds: info.addonIds,
            syntheticServiceName: info.syntheticServiceName,
          }),
      },
    );

    expect(events).toEqual([
      {
        serviceName: 'shell',
        addonIds: ['progress-fixture'],
        syntheticServiceName: 'shell',
      },
    ]);
  });

  it('merges capAddForTarget onto the target without duplicating caps the target already declared', async () => {
    // The env-injection mode exists for cases where the target image runs
    // the agent the addon would otherwise sidecar (e.g. claude-shell's
    // in-process tailscaled). The addon's caps must land on the target,
    // and must dedupe against any caps the operator already declared.
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'caps-fixture',
        envForTarget: { FOO: 'bar' },
        capAddForTarget: ['NET_ADMIN', 'SYS_MODULE'],
      }),
    );

    const target = makeStateful('shell', {
      addons: { 'caps-fixture': {} },
      containerConfig: {
        env: { WORKSPACE_DIR: '/workspace' },
        restartPolicy: 'unless-stopped',
        capAdd: ['NET_ADMIN', 'SYS_PTRACE'], // operator-declared, partial overlap
      },
    });

    const rendered = await expandAddons([target], { ...baseContext, registry });
    expect(rendered).toHaveLength(1);
    expect(rendered[0].containerConfig.capAdd).toEqual(
      expect.arrayContaining(['NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE']),
    );
    // Deduplicated — exactly one NET_ADMIN entry.
    expect(
      rendered[0].containerConfig.capAdd!.filter((c) => c === 'NET_ADMIN'),
    ).toHaveLength(1);
  });

  it('merges devicesForTarget onto the target without duplicating devices the target already declared', async () => {
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'devices-fixture',
        envForTarget: { FOO: 'bar' },
        devicesForTarget: ['/dev/net/tun', '/dev/fuse'],
      }),
    );

    const target = makeStateful('shell', {
      addons: { 'devices-fixture': {} },
      containerConfig: {
        env: { WORKSPACE_DIR: '/workspace' },
        restartPolicy: 'unless-stopped',
        devices: ['/dev/net/tun'], // overlaps with addon-supplied entry
      },
    });

    const rendered = await expandAddons([target], { ...baseContext, registry });
    expect(rendered).toHaveLength(1);
    expect(rendered[0].containerConfig.devices).toEqual(
      expect.arrayContaining(['/dev/net/tun', '/dev/fuse']),
    );
    // Deduplicated — exactly one /dev/net/tun entry.
    expect(
      rendered[0].containerConfig.devices!.filter((d) => d === '/dev/net/tun'),
    ).toHaveLength(1);
  });

  it('writes capAdd onto a target that did not declare any caps', async () => {
    // Fresh target — `capAdd` was undefined before expansion. The merge must
    // populate the field rather than leaving the addon's caps on the floor.
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'caps-fresh',
        envForTarget: { FOO: 'bar' },
        capAddForTarget: ['NET_ADMIN'],
      }),
    );

    const target = makeStateful('shell', { addons: { 'caps-fresh': {} } });
    const rendered = await expandAddons([target], { ...baseContext, registry });
    expect(rendered[0].containerConfig.capAdd).toEqual(['NET_ADMIN']);
  });

  it('writes devices onto a target that did not declare any devices', async () => {
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'devices-fresh',
        envForTarget: { FOO: 'bar' },
        devicesForTarget: ['/dev/net/tun'],
      }),
    );

    const target = makeStateful('shell', { addons: { 'devices-fresh': {} } });
    const rendered = await expandAddons([target], { ...baseContext, registry });
    expect(rendered[0].containerConfig.devices).toEqual(['/dev/net/tun']);
  });

  it('does not touch capAdd / devices when the addon supplies neither and the target declared neither', async () => {
    // Hash-stability guarantee: targets that don't interact with caps/devices
    // at all must come out byte-identical (modulo the env/label merge that
    // every env-injection addon does). The merge writes `undefined` for
    // these fields rather than an empty array so the rendered shape matches
    // the authored shape.
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'no-caps-no-devices',
        envForTarget: { FOO: 'bar' },
      }),
    );

    const target = makeStateful('shell', {
      addons: { 'no-caps-no-devices': {} },
    });
    const rendered = await expandAddons([target], { ...baseContext, registry });
    expect(rendered[0].containerConfig.capAdd).toBeUndefined();
    expect(rendered[0].containerConfig.devices).toBeUndefined();
  });

  it('preserves operator-declared capAdd when the addon supplies none', async () => {
    // Common case: an env-injection addon that only injects env (no caps or
    // devices of its own) must leave the operator's caps alone — not erase
    // them to undefined.
    const registry = createAddonRegistry();
    registry.register(
      makeFixtureAddon({
        id: 'env-only',
        envForTarget: { FOO: 'bar' },
      }),
    );

    const target = makeStateful('shell', {
      addons: { 'env-only': {} },
      containerConfig: {
        env: { WORKSPACE_DIR: '/workspace' },
        restartPolicy: 'unless-stopped',
        capAdd: ['SYS_PTRACE'],
        devices: ['/dev/kvm'],
      },
    });

    const rendered = await expandAddons([target], { ...baseContext, registry });
    expect(rendered[0].containerConfig.capAdd).toEqual(['SYS_PTRACE']);
    expect(rendered[0].containerConfig.devices).toEqual(['/dev/kvm']);
  });

  it('dryRun applies the addon-id label without running provision()', async () => {
    // Plan paths must reflect that the addon is attached (so the diff includes
    // the label) but must not run side-effecting provision() (no authkey
    // minting, no Vault reads).
    let provisionCalls = 0;
    const definition: EnvInjectionAddonDefinition = {
      manifest: {
        id: 'dryrun-fixture',
        mode: 'env-injection',
        description: 'fixture',
        appliesTo: ['Stateful'],
      },
      async provision(): Promise<EnvInjectionProvisionedValues> {
        provisionCalls++;
        return {
          mode: 'env-injection',
          envForTarget: { FOO: 'bar' },
        };
      },
    };
    const registry = createAddonRegistry();
    registry.register({
      manifest: definition.manifest,
      configSchema: z.object({}).strict(),
      definition,
    });

    const target = makeStateful('shell', { addons: { 'dryrun-fixture': {} } });
    const rendered = await expandAddons([target], {
      ...baseContext,
      registry,
      dryRun: true,
    });

    expect(provisionCalls).toBe(0);
    expect(rendered).toHaveLength(1);
    // Label applied so the plan diff still shows the addon is attached.
    expect(rendered[0].containerConfig.labels).toEqual({
      'mini-infra.addon': 'dryrun-fixture',
      'mini-infra.synthetic': 'false',
    });
    // No env merge — provision() was skipped.
    expect(rendered[0].containerConfig.env).toEqual({ WORKSPACE_DIR: '/workspace' });
  });
});

describe('expandAddons — sidecar-mode regression after env-injection split', () => {
  /**
   * Regression guard for the existing Phase-1 contract. The Phase-2 changes
   * to `ProvisionedValues` / `AddonDefinition` introduced a discriminated
   * union; this test re-runs the original Phase-1 round-trip property against
   * the same noop test addon to confirm the sidecar path is byte-identical
   * after the framework changes.
   */
  it('produces the same synthetic sidecar shape for a sidecar-mode addon as Phase 1', async () => {
    // Use a dynamic import to avoid pulling the production-singleton-register
    // side effect through the test loader before the registry is built.
    const { noopAddon } = await import('../test-addons/noop');
    const registry = createAddonRegistry();
    registry.register(noopAddon);

    const target = makeStateful('web', {
      addons: { noop: { label: 'regression' } },
      containerConfig: { env: { FOO: 'bar' }, restartPolicy: 'unless-stopped' },
    });
    const rendered = await expandAddons([target], { ...baseContext, registry });

    expect(rendered).toHaveLength(2);
    const sidecar = rendered.find((s) => s.serviceName === 'web-noop')!;
    expect(sidecar).toBeDefined();
    expect(sidecar.synthetic).toEqual({
      addonIds: ['noop'],
      targetService: 'web',
    });
    expect(sidecar.containerConfig.env).toMatchObject({
      NOOP_TARGET: 'web',
      NOOP_LABEL: 'regression',
    });
    expect(sidecar.containerConfig.labels).toMatchObject({
      'mini-infra.addon': 'noop',
    });

    // Target carries no `mini-infra.addon` label — that's an env-injection-mode
    // signal, not a sidecar-mode signal.
    const renderedTarget = rendered.find((s) => s.serviceName === 'web')!;
    expect(renderedTarget.containerConfig.labels?.['mini-infra.addon']).toBeUndefined();
  });
});
