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

  describe('env-injection mode (claude-shell)', () => {
    it('returns an ssh endpoint for a target labelled mini-infra.addon: claude-shell', () => {
      // env-injection addons don't materialise a synthetic service — they
      // stamp `mini-infra.addon: claude-shell` onto the target's labels.
      const snapshot = snapshotWith([
        {
          serviceName: 'shell',
          serviceType: 'Stateful',
          dockerImage: 'ghcr.io/mrgeoffrich/mini-infra-claude-shell',
          dockerTag: 'latest',
          order: 0,
          containerConfig: {
            labels: {
              'mini-infra.addon': 'claude-shell',
              'mini-infra.synthetic': 'false',
            },
          },
          dependsOn: [],
          addons: { 'claude-shell': {} },
        },
      ]);

      const endpoints = deriveEndpoints(
        snapshot,
        'dev-stack',
        'prod',
        'tailnet-1234.ts.net',
      );

      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]).toMatchObject({
        targetService: 'shell',
        syntheticServiceName: 'shell',
        addonIds: ['claude-shell'],
        kind: 'ssh',
        hostname: sanitizeTailscaleHostname('dev-stack', 'shell', 'prod'),
        url: `ssh root@${sanitizeTailscaleHostname('dev-stack', 'shell', 'prod')}.tailnet-1234.ts.net`,
      });
    });

    it('returns an ssh endpoint with a null URL when the tailnet is unknown', () => {
      const snapshot = snapshotWith([
        {
          serviceName: 'shell',
          serviceType: 'Stateful',
          dockerImage: 'ghcr.io/mrgeoffrich/mini-infra-claude-shell',
          dockerTag: 'latest',
          order: 0,
          containerConfig: {
            labels: { 'mini-infra.addon': 'claude-shell' },
          },
          dependsOn: [],
          addons: { 'claude-shell': {} },
        },
      ]);

      const endpoints = deriveEndpoints(snapshot, 'dev-stack', 'prod', null);

      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]?.url).toBeNull();
      expect(endpoints[0]?.hostname).toBe(
        sanitizeTailscaleHostname('dev-stack', 'shell', 'prod'),
      );
    });

    it('returns no endpoint when the target lacks the claude-shell label', () => {
      // Absent label → no row.
      const snapshot = snapshotWith([
        {
          serviceName: 'shell',
          serviceType: 'Stateful',
          dockerImage: 'ghcr.io/mrgeoffrich/mini-infra-claude-shell',
          dockerTag: 'latest',
          order: 0,
          containerConfig: {},
          dependsOn: [],
        },
      ]);

      const endpoints = deriveEndpoints(
        snapshot,
        'dev-stack',
        'prod',
        'tailnet-1234.ts.net',
      );

      expect(endpoints).toEqual([]);
    });

    it('returns no endpoint when the label is some other addon id', () => {
      // Guards against the env-injection branch misclassifying a future
      // env-injection addon as a claude-shell shell.
      const snapshot = snapshotWith([
        {
          serviceName: 'shell',
          serviceType: 'Stateful',
          dockerImage: 'nginx',
          dockerTag: '1.27',
          order: 0,
          containerConfig: {
            labels: { 'mini-infra.addon': 'some-other-addon' },
          },
          dependsOn: [],
        },
      ]);

      const endpoints = deriveEndpoints(
        snapshot,
        'dev-stack',
        'prod',
        'tailnet-1234.ts.net',
      );

      expect(endpoints).toEqual([]);
    });

    it('returns one ssh endpoint per labelled service when multiple are present', () => {
      const snapshot = snapshotWith([
        {
          serviceName: 'shell-a',
          serviceType: 'Stateful',
          dockerImage: 'ghcr.io/mrgeoffrich/mini-infra-claude-shell',
          dockerTag: 'latest',
          order: 0,
          containerConfig: {
            labels: { 'mini-infra.addon': 'claude-shell' },
          },
          dependsOn: [],
          addons: { 'claude-shell': {} },
        },
        {
          serviceName: 'shell-b',
          serviceType: 'Stateful',
          dockerImage: 'ghcr.io/mrgeoffrich/mini-infra-claude-shell',
          dockerTag: 'latest',
          order: 1,
          containerConfig: {
            labels: { 'mini-infra.addon': 'claude-shell' },
          },
          dependsOn: [],
          addons: { 'claude-shell': {} },
        },
      ]);

      const endpoints = deriveEndpoints(
        snapshot,
        'dev-stack',
        'prod',
        'tailnet-1234.ts.net',
      );

      expect(endpoints).toHaveLength(2);
      expect(endpoints.map((e) => e.targetService).sort()).toEqual(['shell-a', 'shell-b']);
      // Both rows reference the env-injection addon id.
      expect(endpoints.every((e) => e.addonIds.includes('claude-shell'))).toBe(true);
    });

    it('coexists with sidecar-mode endpoints on the same stack', () => {
      // A stack carrying both a tailscale-ssh sidecar (on a different
      // service) and a claude-shell env-injection target should surface
      // both rows, with the env-injection one keyed off the label and the
      // sidecar one keyed off `synthetic`.
      const snapshot = snapshotWith([
        {
          serviceName: 'web',
          serviceType: 'Stateful',
          dockerImage: 'nginx',
          dockerTag: '1.27',
          order: 0,
          containerConfig: {},
          dependsOn: [],
          addons: { 'tailscale-ssh': {} },
        },
        {
          serviceName: 'web-tailscale',
          serviceType: 'Stateful',
          dockerImage: 'tailscale/tailscale',
          dockerTag: 'stable',
          order: 1,
          containerConfig: {},
          dependsOn: ['web'],
          synthetic: { addonIds: ['tailscale-ssh'], targetService: 'web' },
        },
        {
          serviceName: 'shell',
          serviceType: 'Stateful',
          dockerImage: 'ghcr.io/mrgeoffrich/mini-infra-claude-shell',
          dockerTag: 'latest',
          order: 2,
          containerConfig: {
            labels: { 'mini-infra.addon': 'claude-shell' },
          },
          dependsOn: [],
          addons: { 'claude-shell': {} },
        },
      ]);

      const endpoints = deriveEndpoints(
        snapshot,
        'dev-stack',
        'prod',
        'tailnet-1234.ts.net',
      );

      // Two rows total: one ssh endpoint per addon.
      expect(endpoints).toHaveLength(2);
      // Sort order: alphabetical by targetService — `shell` before `web`.
      expect(endpoints[0]?.targetService).toBe('shell');
      expect(endpoints[0]?.addonIds).toEqual(['claude-shell']);
      expect(endpoints[1]?.targetService).toBe('web');
      expect(endpoints[1]?.addonIds).toContain('tailscale-ssh');
    });

    it('skips synthetic services that happen to carry mini-infra.addon labels', () => {
      // Sidecar-mode addons stamp `mini-infra.addon` on the synthetic peer
      // too. The env-injection branch must not double-count those — the
      // sidecar branch already handled them via `synthetic`.
      const snapshot = snapshotWith([
        {
          serviceName: 'web',
          serviceType: 'Stateful',
          dockerImage: 'nginx',
          dockerTag: '1.27',
          order: 0,
          containerConfig: {},
          dependsOn: [],
          addons: { 'tailscale-ssh': {} },
        },
        {
          serviceName: 'web-tailscale',
          serviceType: 'Stateful',
          dockerImage: 'tailscale/tailscale',
          dockerTag: 'stable',
          order: 1,
          containerConfig: {
            // Synthetic services do carry `mini-infra.addon` — guard so
            // env-injection discovery doesn't pick them up.
            labels: { 'mini-infra.addon': 'tailscale' },
          },
          dependsOn: ['web'],
          synthetic: { addonIds: ['tailscale-ssh'], targetService: 'web' },
        },
      ]);

      const endpoints = deriveEndpoints(
        snapshot,
        'dev-stack',
        'prod',
        'tailnet-1234.ts.net',
      );

      // Exactly one row — the sidecar one. No extra row from misclassifying
      // the synthetic peer as an env-injection addon.
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]?.syntheticServiceName).toBe('web-tailscale');
      expect(endpoints[0]?.targetService).toBe('web');
    });
  });
});
