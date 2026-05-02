import { describe, it, expect } from 'vitest';
import type { StackServiceDefinition } from '@mini-infra/types';
import { createAddonRegistry } from '../registry';
import { expandAddons, AddonExpansionError } from '../expand-addons';
import { noopAddon } from '../test-addons/noop';

/**
 * Phase 1 round-trip invariants for the Service Addons render pipeline.
 *
 * These tests pin two properties from the plan's Done-when:
 *   1. A stack service with `addons: { noop: {} }` renders into the original
 *      target (untouched) plus a synthetic sidecar carrying the addon's
 *      back-reference and `synthetic: true`.
 *   2. A stack with no `addons:` declarations on any service round-trips
 *      through `expandAddons` byte-identical (modulo the always-stripped
 *      authored `addons` field, which is undefined for these inputs anyway).
 */

const baseContext = {
  stack: { id: 'stack-test', name: 'test-stack' },
  environment: {
    id: 'env-test',
    name: 'dev',
    networkType: 'local' as const,
  },
};

function makeStateful(name: string, overrides: Partial<StackServiceDefinition> = {}): StackServiceDefinition {
  return {
    serviceName: name,
    serviceType: 'Stateful',
    dockerImage: 'nginx',
    dockerTag: 'latest',
    dependsOn: [],
    order: 1,
    containerConfig: {
      env: { FOO: 'bar' },
      restartPolicy: 'unless-stopped',
    },
    ...overrides,
  };
}

describe('expandAddons (Phase 1)', () => {
  it('appends a synthetic sidecar for a noop-addon application and leaves the target untouched', async () => {
    const registry = createAddonRegistry();
    registry.register(noopAddon);

    const target = makeStateful('web', {
      addons: { noop: { label: 'phase-1-test' } },
    });
    const rendered = await expandAddons([target], { ...baseContext, registry });

    expect(rendered).toHaveLength(2);
    const renderedTarget = rendered.find((s) => s.serviceName === 'web');
    const sidecar = rendered.find((s) => s.serviceName === 'web-noop');
    expect(renderedTarget).toBeDefined();
    expect(sidecar).toBeDefined();

    // Target carries no `addons` field on the rendered output (the authored
    // block is an authoring artifact stripped during render) and is otherwise
    // identical to its authored form.
    expect(renderedTarget!.addons).toBeUndefined();
    expect(renderedTarget!.synthetic).toBeUndefined();
    expect(renderedTarget!.containerConfig).toEqual(target.containerConfig);

    // Synthetic sidecar carries the back-reference and the addon-supplied env.
    expect(sidecar!.synthetic).toEqual({
      addonIds: ['noop'],
      targetService: 'web',
    });
    expect(sidecar!.containerConfig.env).toMatchObject({
      NOOP_TARGET: 'web',
      NOOP_LABEL: 'phase-1-test',
    });
  });

  it('round-trips an authored stack with no addons declarations byte-identical', async () => {
    const registry = createAddonRegistry();
    registry.register(noopAddon);

    const services: StackServiceDefinition[] = [
      makeStateful('web'),
      makeStateful('worker', { dockerImage: 'busybox' }),
    ];
    const rendered = await expandAddons(services, { ...baseContext, registry });

    expect(rendered).toHaveLength(services.length);
    for (const original of services) {
      const out = rendered.find((s) => s.serviceName === original.serviceName);
      expect(out).toBeDefined();
      // No `addons` block on input, so output should match the input
      // (with the always-undefined `addons` field absent in both).
      expect(out).toEqual(original);
    }
  });

  it('rejects an unregistered addon id with a structured AddonExpansionError', async () => {
    const registry = createAddonRegistry();
    const target = makeStateful('web', { addons: { 'does-not-exist': {} } });

    await expect(expandAddons([target], { ...baseContext, registry })).rejects.toBeInstanceOf(
      AddonExpansionError,
    );
  });

  it('rejects an addon applied to an unsupported service type', async () => {
    const registry = createAddonRegistry();
    registry.register({
      ...noopAddon,
      manifest: { ...noopAddon.manifest, appliesTo: ['Pool'] },
    });

    const target = makeStateful('web', { addons: { noop: {} } });
    await expect(expandAddons([target], { ...baseContext, registry })).rejects.toThrow(
      /does not apply to service type "Stateful"/,
    );
  });

  it('rejects an invalid addon config via the manifest configSchema', async () => {
    const registry = createAddonRegistry();
    registry.register(noopAddon);

    const target = makeStateful('web', {
      addons: { noop: { label: 12345 as unknown as string } },
    });
    await expect(expandAddons([target], { ...baseContext, registry })).rejects.toThrow(
      /Invalid config/,
    );
  });

  it('emits onProvisioned progress callbacks per successful application', async () => {
    const registry = createAddonRegistry();
    registry.register(noopAddon);

    const target = makeStateful('web', { addons: { noop: {} } });
    const provisioned: Array<{ serviceName: string; addonIds: string[] }> = [];
    await expandAddons(
      [target],
      { ...baseContext, registry },
      {
        onProvisioned: (info) =>
          provisioned.push({ serviceName: info.serviceName, addonIds: info.addonIds }),
      },
    );
    expect(provisioned).toEqual([{ serviceName: 'web', addonIds: ['noop'] }]);
  });
});
