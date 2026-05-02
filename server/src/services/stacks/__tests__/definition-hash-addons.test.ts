import { describe, it, expect } from 'vitest';
import type { StackServiceDefinition } from '@mini-infra/types';
import { computeDefinitionHash } from '../definition-hash';
import { resolveServiceConfigs } from '../utils';
import { buildTemplateContext } from '../template-engine';
import { createAddonRegistry } from '../../stack-addons';
import { noopAddon } from '../../stack-addons/test-addons/noop';

/**
 * Service Addons §7 invariant: the definition hash for an authored service
 * is computed from the authored `addons:` block (and the rest of the
 * authored definition), not the rendered form. So:
 *  - changing addon-config recreates the target service;
 *  - mint-on-render values like authkeys never enter this hash.
 */
describe('definition-hash with addons block', () => {
  const baseService: StackServiceDefinition = {
    serviceName: 'web',
    serviceType: 'Stateful',
    dockerImage: 'nginx',
    dockerTag: 'latest',
    dependsOn: [],
    order: 1,
    containerConfig: {
      env: { FOO: 'bar' },
      restartPolicy: 'unless-stopped',
    },
  };

  it('includes the authored addons block — config changes change the hash', () => {
    const withoutAddons = computeDefinitionHash(baseService);
    const withNoop = computeDefinitionHash({
      ...baseService,
      addons: { noop: {} },
    });
    const withNoopLabel = computeDefinitionHash({
      ...baseService,
      addons: { noop: { label: 'a' } },
    });
    const withNoopOtherLabel = computeDefinitionHash({
      ...baseService,
      addons: { noop: { label: 'b' } },
    });

    expect(withoutAddons).not.toBe(withNoop);
    expect(withNoop).not.toBe(withNoopLabel);
    expect(withNoopLabel).not.toBe(withNoopOtherLabel);
  });

  it('is stable across calls for the same authored definition', () => {
    const a = computeDefinitionHash({
      ...baseService,
      addons: { noop: { label: 'x' } },
    });
    const b = computeDefinitionHash({
      ...baseService,
      addons: { noop: { label: 'x' } },
    });
    expect(a).toBe(b);
  });
});

/**
 * §7 invariant pinned at the pipeline boundary, not just at the hash
 * function. `expandAddons` strips the `addons:` field from the rendered
 * output (the rendered form is post-authoring); the integration test
 * proves `resolveServiceConfigs` re-attaches the authored block before
 * computing the target's hash, so addon-config changes still trigger a
 * recreate of the target.
 */
describe('resolveServiceConfigs — §7 hash invariant pinned end-to-end', () => {
  function makeServiceRow(addons: Record<string, unknown> | undefined) {
    return {
      serviceName: 'web',
      serviceType: 'Stateful',
      dockerImage: 'nginx',
      dockerTag: 'latest',
      containerConfig: { restartPolicy: 'unless-stopped' },
      configFiles: [],
      initCommands: [],
      dependsOn: [],
      order: 1,
      routing: null,
      addons,
    };
  }

  it("changes the target's service hash when the authored addons block changes", async () => {
    const registry = createAddonRegistry();
    registry.register(noopAddon);

    const ctxA = buildTemplateContext(
      { name: 'demo', networks: [], volumes: [] },
      [{ serviceName: 'web', dockerImage: 'nginx', dockerTag: 'latest', containerConfig: { restartPolicy: 'unless-stopped' } }],
    );
    const ctxB = buildTemplateContext(
      { name: 'demo', networks: [], volumes: [] },
      [{ serviceName: 'web', dockerImage: 'nginx', dockerTag: 'latest', containerConfig: { restartPolicy: 'unless-stopped' } }],
    );

    const { serviceHashes: hashA } = await resolveServiceConfigs(
      [makeServiceRow({ noop: { label: 'a' } })],
      ctxA,
      { addonRegistry: registry },
    );
    const { serviceHashes: hashB } = await resolveServiceConfigs(
      [makeServiceRow({ noop: { label: 'b' } })],
      ctxB,
      { addonRegistry: registry },
    );

    const targetHashA = hashA.get('web');
    const targetHashB = hashB.get('web');
    expect(targetHashA).toBeDefined();
    expect(targetHashB).toBeDefined();
    expect(targetHashA).not.toBe(targetHashB);
  });
});
