import {
  translateUnifiedNetworkDeclarations,
  isUnifiedStackNetworkDeclaration,
  UnifiedNetworkDeclarationError,
} from '../unified-network-declarations';
import type { StackContainerConfig } from '@mini-infra/types';

function svc(serviceName: string, containerConfig: StackContainerConfig = {}, networks?: string[]) {
  return { serviceName, containerConfig, networks };
}

describe('isUnifiedStackNetworkDeclaration', () => {
  it('distinguishes the unified {purpose} shape from the legacy {name} shape', () => {
    expect(isUnifiedStackNetworkDeclaration({ purpose: 'default' })).toBe(true);
    expect(isUnifiedStackNetworkDeclaration({ purpose: 'default', scope: 'environment' })).toBe(true);
    expect(isUnifiedStackNetworkDeclaration({ name: 'default' })).toBe(false);
  });
});

describe('translateUnifiedNetworkDeclarations', () => {
  it('passes pure legacy input through unchanged (identity for existing templates)', () => {
    const input = {
      networks: [{ name: 'default' }, { name: 'extra', driver: 'bridge' }],
      resourceOutputs: [{ type: 'docker-network', purpose: 'shared' }],
      resourceInputs: [{ type: 'docker-network', purpose: 'vault', optional: true }],
      services: [svc('api', { joinNetworks: ['ext-net'] }), svc('worker', { joinResourceNetworks: ['shared'] })],
    };
    const result = translateUnifiedNetworkDeclarations(input);
    expect(result.networks).toEqual(input.networks);
    expect(result.resourceOutputs).toEqual(input.resourceOutputs);
    expect(result.resourceInputs).toEqual(input.resourceInputs);
    expect(result.services).toEqual([
      { serviceName: 'api', containerConfig: { joinNetworks: ['ext-net'] } },
      { serviceName: 'worker', containerConfig: { joinResourceNetworks: ['shared'] } },
    ]);
  });

  it('translates a stack-scope unified declaration (scope omitted) to a legacy networks[] entry', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ purpose: 'default' }],
      services: [],
    });
    expect(result.networks).toEqual([{ name: 'default' }]);
    expect(result.resourceOutputs).toBeUndefined();
  });

  it('translates an explicit scope: "stack" the same as scope omitted', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ purpose: 'default', scope: 'stack' }],
      services: [],
    });
    expect(result.networks).toEqual([{ name: 'default' }]);
  });

  it('translates scope: "environment"/"host" unified declarations to resourceOutputs[] entries', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [
        { purpose: 'applications', scope: 'environment' },
        { purpose: 'shared', scope: 'host' },
      ],
      services: [],
    });
    expect(result.networks).toEqual([]);
    expect(result.resourceOutputs).toEqual([
      { type: 'docker-network', purpose: 'applications' },
      { type: 'docker-network', purpose: 'shared' },
    ]);
  });

  it('merges unified-derived resourceOutputs with any pre-existing legacy resourceOutputs', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ purpose: 'new-shared', scope: 'environment' }],
      resourceOutputs: [{ type: 'docker-network', purpose: 'existing', joinSelf: true }],
      services: [],
    });
    expect(result.resourceOutputs).toEqual([
      { type: 'docker-network', purpose: 'existing', joinSelf: true },
      { type: 'docker-network', purpose: 'new-shared' },
    ]);
  });

  it('mixes legacy and unified entries in the same networks[] array without conflict', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ name: 'legacy-net' }, { purpose: 'unified-net' }],
      services: [],
    });
    expect(result.networks).toEqual(
      expect.arrayContaining([{ name: 'legacy-net' }, { name: 'unified-net' }]),
    );
    expect(result.networks).toHaveLength(2);
  });

  it('a per-service networks[] purpose resolving to stack scope is a no-op (already auto-joined)', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ purpose: 'default' }],
      services: [svc('api', {}, ['default'])],
    });
    expect(result.services).toEqual([{ serviceName: 'api', containerConfig: {} }]);
  });

  it('a per-service networks[] purpose resolving to resource scope merges into joinResourceNetworks', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ purpose: 'default' }, { purpose: 'applications', scope: 'environment' }],
      services: [svc('api', {}, ['default', 'applications'])],
    });
    expect(result.services).toEqual([
      { serviceName: 'api', containerConfig: { joinResourceNetworks: ['applications'] } },
    ]);
  });

  it('merges a per-service unified networks[] purpose with a pre-existing joinResourceNetworks list, deduping', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ purpose: 'applications', scope: 'environment' }],
      services: [svc('api', { joinResourceNetworks: ['applications', 'other'] }, ['applications'])],
    });
    expect(result.services![0].containerConfig.joinResourceNetworks).toEqual(
      expect.arrayContaining(['applications', 'other']),
    );
    expect(result.services![0].containerConfig.joinResourceNetworks).toHaveLength(2);
  });

  it('resolves a per-service networks[] purpose declared via legacy resourceOutputs (cross-mechanism mixing)', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ name: 'default' }],
      resourceOutputs: [{ type: 'docker-network', purpose: 'legacy-shared' }],
      services: [svc('worker', {}, ['legacy-shared'])],
    });
    expect(result.services).toEqual([
      { serviceName: 'worker', containerConfig: { joinResourceNetworks: ['legacy-shared'] } },
    ]);
  });

  it('resolves a per-service networks[] purpose declared via legacy resourceInputs (cross-mechanism mixing)', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ name: 'default' }],
      resourceInputs: [{ type: 'docker-network', purpose: 'vault', optional: true }],
      services: [svc('worker', {}, ['vault'])],
    });
    expect(result.services).toEqual([
      { serviceName: 'worker', containerConfig: { joinResourceNetworks: ['vault'] } },
    ]);
  });

  it('throws when a unified declaration collides with a legacy networks[] entry of the same name', () => {
    expect(() =>
      translateUnifiedNetworkDeclarations({
        networks: [{ name: 'default' }, { purpose: 'default' }],
        services: [],
      }),
    ).toThrow(UnifiedNetworkDeclarationError);
  });

  it('throws on a duplicate unified declaration for the same purpose', () => {
    expect(() =>
      translateUnifiedNetworkDeclarations({
        networks: [{ purpose: 'x', scope: 'stack' }, { purpose: 'x', scope: 'environment' }],
        services: [],
      }),
    ).toThrow(UnifiedNetworkDeclarationError);
  });

  it('throws when a unified environment/host declaration collides with an existing resourceOutputs purpose', () => {
    expect(() =>
      translateUnifiedNetworkDeclarations({
        networks: [{ purpose: 'shared', scope: 'environment' }],
        resourceOutputs: [{ type: 'docker-network', purpose: 'shared' }],
        services: [],
      }),
    ).toThrow(UnifiedNetworkDeclarationError);
  });

  it('throws when a unified STACK-scope declaration collides with an existing resourceOutputs purpose', () => {
    expect(() =>
      translateUnifiedNetworkDeclarations({
        networks: [{ purpose: 'foo' }], // scope omitted -> stack
        resourceOutputs: [{ type: 'docker-network', purpose: 'foo' }],
        services: [],
      }),
    ).toThrow(UnifiedNetworkDeclarationError);
  });

  it('throws when a unified STACK-scope declaration collides with an existing resourceInputs purpose', () => {
    expect(() =>
      translateUnifiedNetworkDeclarations({
        networks: [{ purpose: 'foo', scope: 'stack' }],
        resourceInputs: [{ type: 'docker-network', purpose: 'foo' }],
        services: [],
      }),
    ).toThrow(UnifiedNetworkDeclarationError);
  });

  it('tolerates two legacy networks[] entries sharing the same name (pre-existing, unchanged tolerance)', () => {
    const result = translateUnifiedNetworkDeclarations({
      networks: [{ name: 'dup' }, { name: 'dup' }],
      services: [],
    });
    expect(result.networks).toEqual([{ name: 'dup' }, { name: 'dup' }]);
  });

  it('throws when a service references an undeclared network purpose', () => {
    expect(() =>
      translateUnifiedNetworkDeclarations({
        networks: [{ purpose: 'default' }],
        services: [svc('api', {}, ['nonexistent'])],
      }),
    ).toThrow(UnifiedNetworkDeclarationError);
  });

  it('throws when services[].networks is used without a top-level networks[] array', () => {
    expect(() =>
      translateUnifiedNetworkDeclarations({
        services: [svc('api', {}, ['default'])],
      }),
    ).toThrow(UnifiedNetworkDeclarationError);
  });

  it('leaves resourceOutputs/resourceInputs/services untouched when networks[] is undefined and no service uses the sugar field (partial update no-op)', () => {
    const result = translateUnifiedNetworkDeclarations({
      resourceOutputs: [{ type: 'docker-network', purpose: 'shared' }],
      services: [svc('api')],
    });
    expect(result.networks).toBeUndefined();
    expect(result.resourceOutputs).toEqual([{ type: 'docker-network', purpose: 'shared' }]);
    expect(result.services).toEqual([{ serviceName: 'api', containerConfig: {} }]);
  });

  it('handles a completely empty input gracefully', () => {
    const result = translateUnifiedNetworkDeclarations({});
    expect(result.networks).toBeUndefined();
    expect(result.resourceOutputs).toBeUndefined();
    expect(result.resourceInputs).toBeUndefined();
    expect(result.services).toBeUndefined();
  });
});
