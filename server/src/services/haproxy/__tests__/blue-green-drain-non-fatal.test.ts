import { describe, it, expect } from 'vitest';
import { transition, type AnyStateMachine } from 'xstate';
import {
  blueGreenUpdateMachine,
  type BlueGreenUpdateContext,
} from '../blue-green-update-state-machine';
import {
  blueGreenDeploymentMachine,
  type BlueGreenDeploymentContext,
} from '../blue-green-deployment-state-machine';

/**
 * Regression guard for the "update succeeded but the tracker reported failed" bug.
 *
 * In both blue-green machines, traffic is cut over to green (which is already
 * health-checked and live) *before* the old blue container is drained and
 * removed. Previously, a slow or failing drain of that superseded blue —
 * DRAIN_TIMEOUT, DRAIN_ISSUES, or the 2-minute `after` fallback — rolled the
 * whole deployment back, ending in `rollbackComplete`. That final state makes
 * the reconciler report `success: false`, which the UI renders as "failed" even
 * though the new version was already serving every request.
 *
 * Draining the superseded blue must be non-critical (force-remove blue) and land
 * in `completed`, exactly like the later blue-teardown steps (LB removal / stop /
 * remove) already are. These tests drive the *real* machines with xstate's pure
 * `transition()` (no side effects executed) to pin that behaviour.
 */

const baseUpdateContext: BlueGreenUpdateContext = {
  deploymentId: 'dep-1',
  configurationId: 'cfg-1',
  applicationName: 'kumiko-designer',
  dockerImage: 'ghcr.io/example/app',
  environmentId: 'env-1',
  environmentName: 'prod',
  haproxyContainerId: 'haproxy-1',
  haproxyNetworkName: 'prod-haproxy',
  blueHealthy: true,
  greenHealthy: true,
  greenBackendConfigured: true,
  trafficOpenedToGreen: true,
  trafficValidated: true,
  blueDraining: true,
  blueDrained: false,
  validationErrors: 0,
  retryCount: 0,
  activeConnections: 1,
  triggerType: 'manual',
  startTime: 0,
  oldContainerId: 'old-blue-container-id',
  newContainerId: 'new-green-container-id',
};

const baseDeploymentContext: BlueGreenDeploymentContext = {
  ...baseUpdateContext,
  frontendConfigured: true,
};

const machines: Array<{
  name: string;
  machine: AnyStateMachine;
  context: Record<string, unknown>;
}> = [
  {
    name: 'blue-green update (redeploy / same tag)',
    machine: blueGreenUpdateMachine,
    context: baseUpdateContext,
  },
  {
    name: 'blue-green deployment (tag change)',
    machine: blueGreenDeploymentMachine,
    context: baseDeploymentContext,
  },
];

describe.each(machines)(
  '$name — post-cutover blue drain is non-fatal',
  ({ machine, context }) => {
    // Pure single-step transition from a synthetic snapshot at `value`.
    const step = (value: string, event: { type: string }) => {
      const snapshot = machine.resolveState({ value, context });
      return transition(machine, snapshot, event)[0];
    };

    it('routes a drain timeout in waitingForDrain to blue teardown, not rollback', () => {
      const next = step('waitingForDrain', { type: 'DRAIN_TIMEOUT' });
      expect(next.value).toBe('decommissioningBlueLB');
      expect(String(next.value)).not.toContain('rollback');
      expect(next.context.error).toContain('Non-Critical');
    });

    it('routes drain issues in waitingForDrain to blue teardown, not rollback', () => {
      const next = step('waitingForDrain', {
        type: 'DRAIN_ISSUES',
        error: 'dataplane hiccup',
      });
      expect(next.value).toBe('decommissioningBlueLB');
      expect(String(next.value)).not.toContain('rollback');
    });

    it('routes drain-initiation issues in drainingBlue to blue teardown, not rollback', () => {
      const next = step('drainingBlue', {
        type: 'DRAIN_ISSUES',
        error: 'could not set drain mode',
      });
      expect(next.value).toBe('decommissioningBlueLB');
      expect(String(next.value)).not.toContain('rollback');
    });

    it('drives a drain timeout all the way to completed (success), never rollbackComplete', () => {
      // waitingForDrain --DRAIN_TIMEOUT--> decommission --> stop --> remove --> completed
      let snapshot = machine.resolveState({ value: 'waitingForDrain', context });
      snapshot = transition(machine, snapshot, { type: 'DRAIN_TIMEOUT' })[0];
      expect(snapshot.value).toBe('decommissioningBlueLB');
      snapshot = transition(machine, snapshot, { type: 'LB_REMOVAL_SUCCESS' })[0];
      expect(snapshot.value).toBe('stoppingBlueApp');
      snapshot = transition(machine, snapshot, { type: 'STOP_SUCCESS' })[0];
      expect(snapshot.value).toBe('removingBlueApp');
      snapshot = transition(machine, snapshot, { type: 'REMOVAL_SUCCESS' })[0];
      expect(snapshot.value).toBe('completed');
      expect(snapshot.status).toBe('done');
    });
  },
);
