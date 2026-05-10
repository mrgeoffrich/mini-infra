import { describe, it, expect } from 'vitest';
import type { StackServiceDefinition, StackDefinition } from '@mini-infra/types';
import { buildAppliedSnapshot } from '../stack-applied-snapshot';

/**
 * Regression test: the `lastAppliedSnapshot` written after a successful apply
 * must include addon-derived synthetic sidecars when the rendered service map
 * is supplied. `GET /api/stacks/:id/addon-endpoints` walks the snapshot
 * looking for entries with a `synthetic` marker — without those entries it
 * returns `endpoints: []` and the Connect panel stays empty.
 */
describe('buildAppliedSnapshot', () => {
  const baseStack = {
    name: 'web-stack',
    description: null,
    networks: [{ name: 'web' }],
    volumes: [],
    parameters: [],
    resourceOutputs: [],
    resourceInputs: [],
    tlsCertificates: [],
    dnsRecords: [],
    tunnelIngress: [],
    services: [
      {
        serviceName: 'web',
        serviceType: 'Stateful',
        dockerImage: 'nginx',
        dockerTag: '1.27',
        order: 0,
        containerConfig: { ports: [], restartPolicy: 'unless-stopped' },
        configFiles: null,
        initCommands: null,
        dependsOn: [],
        routing: null,
        adoptedContainer: null,
        addons: { 'tailscale-web': { port: 80 } },
      },
    ],
  };

  it('falls back to authored services when no rendered map is supplied', () => {
    const snapshot = buildAppliedSnapshot(baseStack) as unknown as StackDefinition;
    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0]?.serviceName).toBe('web');
    expect(snapshot.services[0]?.synthetic).toBeUndefined();
    expect(snapshot.services[0]?.addons).toEqual({ 'tailscale-web': { port: 80 } });
  });

  it('persists synthetic sidecars when the rendered service map is supplied', () => {
    const target: StackServiceDefinition = {
      serviceName: 'web',
      serviceType: 'Stateful',
      dockerImage: 'nginx',
      dockerTag: '1.27',
      order: 0,
      containerConfig: { ports: [], restartPolicy: 'unless-stopped' },
      dependsOn: [],
    };
    const sidecar: StackServiceDefinition = {
      serviceName: 'web-tailscale',
      serviceType: 'Stateful',
      dockerImage: 'tailscale/tailscale',
      dockerTag: 'stable',
      order: 1,
      containerConfig: {
        env: { TS_HOSTNAME: 'web-prod' },
        labels: {
          'mini-infra.synthetic': 'true',
          'mini-infra.addon-target': 'web',
          'mini-infra.addon': 'tailscale-web',
        },
      },
      dependsOn: ['web'],
      synthetic: {
        addonIds: ['tailscale-web'],
        kind: undefined,
        targetService: 'web',
      },
    };
    const rendered = new Map<string, StackServiceDefinition>([
      ['web', target],
      ['web-tailscale', sidecar],
    ]);

    const snapshot = buildAppliedSnapshot(baseStack, rendered) as unknown as StackDefinition;

    expect(snapshot.services).toHaveLength(2);
    const persistedSidecar = snapshot.services.find((s) => s.serviceName === 'web-tailscale');
    expect(persistedSidecar).toBeDefined();
    expect(persistedSidecar?.synthetic).toEqual({
      addonIds: ['tailscale-web'],
      kind: undefined,
      targetService: 'web',
    });
    // Synthetic services must be discoverable by the addon-endpoints route,
    // which keys off `synthetic.addonIds.includes('tailscale-web')`.
    expect(persistedSidecar?.synthetic?.addonIds).toContain('tailscale-web');
  });
});
