import { describe, it, expect } from 'vitest';
import type { StackServiceDefinition } from '@mini-infra/types';
import { computeDefinitionHash } from '../definition-hash';

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
