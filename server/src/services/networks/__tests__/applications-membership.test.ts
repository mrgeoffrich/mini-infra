import type { StackResourceInput, StackServiceDefinition, StackServiceType } from '@mini-infra/types';
import {
  stackNeedsApplicationsNetwork,
  ensureApplicationsResourceInput,
  ensureApplicationsJoinResourceNetwork,
  ensureApplicationsMembership,
} from '../applications-membership';

function makeService(
  serviceType: StackServiceType,
  joinResourceNetworks?: string[],
): StackServiceDefinition {
  return {
    serviceName: `svc-${serviceType}`,
    serviceType,
    dockerImage: 'nginx',
    dockerTag: 'latest',
    containerConfig: joinResourceNetworks ? { joinResourceNetworks } : {},
    dependsOn: [],
    order: 0,
  };
}

const APPLICATIONS_INPUT: StackResourceInput = { type: 'docker-network', purpose: 'applications' };

describe('applications-membership', () => {
  describe('stackNeedsApplicationsNetwork', () => {
    it('is true when any service routes through HAProxy', () => {
      expect(stackNeedsApplicationsNetwork([makeService('Stateful'), makeService('StatelessWeb')])).toBe(true);
      expect(stackNeedsApplicationsNetwork([makeService('AdoptedWeb')])).toBe(true);
    });

    it('is false for stacks with no HAProxy-routed service', () => {
      expect(stackNeedsApplicationsNetwork([makeService('Stateful'), makeService('Pool')])).toBe(false);
      expect(stackNeedsApplicationsNetwork([])).toBe(false);
    });
  });

  describe('ensureApplicationsResourceInput', () => {
    it('appends the applications docker-network input when absent', () => {
      expect(ensureApplicationsResourceInput([])).toEqual([APPLICATIONS_INPUT]);
    });

    it('is idempotent when the input is already present', () => {
      const inputs = [APPLICATIONS_INPUT];
      expect(ensureApplicationsResourceInput(inputs)).toBe(inputs);
    });

    it('preserves unrelated resource inputs', () => {
      const inputs: StackResourceInput[] = [{ type: 'docker-network', purpose: 'dataplane' }];
      expect(ensureApplicationsResourceInput(inputs)).toEqual([...inputs, APPLICATIONS_INPUT]);
    });
  });

  describe('ensureApplicationsJoinResourceNetwork', () => {
    it('adds the applications join for HAProxy-routed services', () => {
      expect(ensureApplicationsJoinResourceNetwork(makeService('StatelessWeb')).containerConfig.joinResourceNetworks).toEqual([
        'applications',
      ]);
      expect(ensureApplicationsJoinResourceNetwork(makeService('AdoptedWeb')).containerConfig.joinResourceNetworks).toEqual([
        'applications',
      ]);
    });

    it('leaves non-routed services untouched (same reference)', () => {
      const svc = makeService('Stateful');
      expect(ensureApplicationsJoinResourceNetwork(svc)).toBe(svc);
    });

    it('is idempotent when the join is already declared (same reference)', () => {
      const svc = makeService('StatelessWeb', ['applications']);
      expect(ensureApplicationsJoinResourceNetwork(svc)).toBe(svc);
    });

    it('merges with existing joinResourceNetworks without dropping them', () => {
      const svc = makeService('StatelessWeb', ['vault']);
      expect(ensureApplicationsJoinResourceNetwork(svc).containerConfig.joinResourceNetworks).toEqual([
        'vault',
        'applications',
      ]);
    });

    it('does not mutate the input definition', () => {
      const svc = makeService('StatelessWeb');
      ensureApplicationsJoinResourceNetwork(svc);
      expect(svc.containerConfig.joinResourceNetworks).toBeUndefined();
    });
  });

  describe('ensureApplicationsMembership', () => {
    it('is a no-op for host-scoped stacks (null environment)', () => {
      const resourceInputs: StackResourceInput[] = [];
      const resolvedDefinitions = new Map([['a', makeService('StatelessWeb')]]);
      const result = ensureApplicationsMembership(null, { resourceInputs, resolvedDefinitions });
      expect(result.resourceInputs).toBe(resourceInputs);
      expect(result.resolvedDefinitions).toBe(resolvedDefinitions);
    });

    it('is a no-op for stacks with no HAProxy-routed service', () => {
      const resourceInputs: StackResourceInput[] = [];
      const resolvedDefinitions = new Map([['a', makeService('Stateful')]]);
      const result = ensureApplicationsMembership('env-1', { resourceInputs, resolvedDefinitions });
      expect(result.resourceInputs).toBe(resourceInputs);
      expect(result.resolvedDefinitions).toBe(resolvedDefinitions);
    });

    it('injects the resource input and per-service join for env-scoped routed stacks', () => {
      const resourceInputs: StackResourceInput[] = [];
      const resolvedDefinitions = new Map<string, StackServiceDefinition>([
        ['web', makeService('StatelessWeb')],
        ['db', makeService('Stateful')],
      ]);
      const result = ensureApplicationsMembership('env-1', { resourceInputs, resolvedDefinitions });

      expect(result.resourceInputs).toEqual([APPLICATIONS_INPUT]);
      expect(result.resolvedDefinitions.get('web')?.containerConfig.joinResourceNetworks).toEqual(['applications']);
      // Non-routed services in the same stack are left alone.
      expect(result.resolvedDefinitions.get('db')?.containerConfig.joinResourceNetworks).toBeUndefined();
    });

    it('does not mutate the inputs', () => {
      const resourceInputs: StackResourceInput[] = [];
      const web = makeService('StatelessWeb');
      const resolvedDefinitions = new Map([['web', web]]);
      ensureApplicationsMembership('env-1', { resourceInputs, resolvedDefinitions });
      expect(resourceInputs).toEqual([]);
      expect(web.containerConfig.joinResourceNetworks).toBeUndefined();
    });
  });
});
