import { describe, it, expect } from 'vitest';
import { sanitizeTailscaleHostname, type StackDefinition } from '@mini-infra/types';
import { deriveEndpoints } from '../stacks-addon-endpoints-route';

function snapshotWith(services: StackDefinition['services']): StackDefinition {
  return {
    name: 'web-stack',
    networks: [{ name: 'web' }],
    volumes: [],
    services,
  };
}

describe('deriveEndpoints', () => {
  it('returns the tailnet HTTPS URL for a tailscale-web synthetic sidecar', () => {
    const snapshot = snapshotWith([
      {
        serviceName: 'web',
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: '1.27',
        order: 0,
        containerConfig: {},
        dependsOn: [],
        addons: { 'tailscale-web': { port: 80 } },
      },
      {
        serviceName: 'web-tailscale',
        serviceType: 'Stateful',
        dockerImage: 'tailscale/tailscale',
        dockerTag: 'stable',
        order: 1,
        containerConfig: {},
        dependsOn: ['web'],
        synthetic: { addonIds: ['tailscale-web'], targetService: 'web' },
      },
    ]);

    const endpoints = deriveEndpoints(snapshot, 'web-stack', 'prod', 'tailnet-1234.ts.net');

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({
      targetService: 'web',
      syntheticServiceName: 'web-tailscale',
      kind: 'https',
      hostname: sanitizeTailscaleHostname('web-stack', 'web', 'prod'),
      url: `https://${sanitizeTailscaleHostname('web-stack', 'web', 'prod')}.tailnet-1234.ts.net`,
    });
  });

  it('appends the configured non-root path to the URL', () => {
    const snapshot = snapshotWith([
      {
        serviceName: 'web',
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: '1.27',
        order: 0,
        containerConfig: {},
        dependsOn: [],
        addons: { 'tailscale-web': { port: 8080, path: '/api' } },
      },
      {
        serviceName: 'web-tailscale',
        serviceType: 'Stateful',
        dockerImage: 'tailscale/tailscale',
        dockerTag: 'stable',
        order: 1,
        containerConfig: {},
        dependsOn: ['web'],
        synthetic: { addonIds: ['tailscale-web'], targetService: 'web' },
      },
    ]);

    const endpoints = deriveEndpoints(snapshot, 'web-stack', 'prod', 'tailnet-1234.ts.net');

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.url).toBe(
      `https://${sanitizeTailscaleHostname('web-stack', 'web', 'prod')}.tailnet-1234.ts.net/api`,
    );
  });

  it('returns the endpoint with a null URL when the tailnet is unknown', () => {
    const snapshot = snapshotWith([
      {
        serviceName: 'web',
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: '1.27',
        order: 0,
        containerConfig: {},
        dependsOn: [],
        addons: { 'tailscale-web': { port: 80 } },
      },
      {
        serviceName: 'web-tailscale',
        serviceType: 'Stateful',
        dockerImage: 'tailscale/tailscale',
        dockerTag: 'stable',
        order: 1,
        containerConfig: {},
        dependsOn: ['web'],
        synthetic: { addonIds: ['tailscale-web'], targetService: 'web' },
      },
    ]);

    const endpoints = deriveEndpoints(snapshot, 'web-stack', 'prod', null);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.url).toBeNull();
    expect(endpoints[0]?.hostname).toBe(sanitizeTailscaleHostname('web-stack', 'web', 'prod'));
  });

  it('returns both ssh and https endpoints, sorted ssh before https, when both addons merge on one service', () => {
    const snapshot = snapshotWith([
      {
        serviceName: 'web',
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: '1.27',
        order: 0,
        containerConfig: {},
        dependsOn: [],
        addons: {
          'tailscale-ssh': {},
          'tailscale-web': { port: 80 },
        },
      },
      {
        serviceName: 'web-tailscale',
        serviceType: 'Stateful',
        dockerImage: 'tailscale/tailscale',
        dockerTag: 'stable',
        order: 1,
        containerConfig: {},
        dependsOn: ['web'],
        synthetic: {
          addonIds: ['tailscale-ssh', 'tailscale-web'],
          kind: 'tailscale',
          targetService: 'web',
        },
      },
    ]);

    const endpoints = deriveEndpoints(snapshot, 'web-stack', 'prod', 'tailnet-1234.ts.net');

    expect(endpoints.map((e) => e.kind)).toEqual(['ssh', 'https']);
    expect(endpoints[0]?.url).toMatch(/^ssh root@/);
    expect(endpoints[1]?.url).toMatch(/^https:\/\//);
  });

  it('returns no endpoints when the snapshot has no synthetics', () => {
    // Reproduces the pre-fix bug: before `buildAppliedSnapshot` learned to
    // include rendered services, the snapshot only carried authored services
    // and this path always returned empty even for stacks with the addon.
    const snapshot = snapshotWith([
      {
        serviceName: 'web',
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: '1.27',
        order: 0,
        containerConfig: {},
        dependsOn: [],
        addons: { 'tailscale-web': { port: 80 } },
      },
    ]);

    const endpoints = deriveEndpoints(snapshot, 'web-stack', 'prod', 'tailnet-1234.ts.net');

    expect(endpoints).toEqual([]);
  });
});
