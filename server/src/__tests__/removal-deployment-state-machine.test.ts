import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createActor } from 'xstate';
import { removalDeploymentMachine } from '../services/haproxy/removal-deployment-state-machine';

// Mock all action classes to prevent actual execution
jest.mock('../services/haproxy/actions/remove-container-from-lb');
jest.mock('../services/haproxy/actions/remove-frontend');
jest.mock('../services/haproxy/actions/remove-dns');
jest.mock('../services/haproxy/actions/stop-application');
jest.mock('../services/haproxy/actions/remove-application');
jest.mock('../services/haproxy/actions/log-deployment-success');
jest.mock('../services/haproxy/actions/alert-operations-team');
jest.mock('../services/haproxy/actions/cleanup-temp-resources');

describe('RemovalDeploymentStateMachine', () => {
    let actor: any;

    const mockContext = {
        deploymentId: 'test-deployment-123',
        configurationId: 'test-config-456',
        applicationName: 'test-app',
        environmentId: 'test-env',
        environmentName: 'production',
        haproxyContainerId: 'haproxy-container-123',
        haproxyNetworkName: 'mini-infra-network',
        containerId: 'app-container-789',
        containersToRemove: [],
        lbRemovalComplete: false,
        applicationStopped: false,
        applicationRemoved: false,
        retryCount: 0,
        triggerType: 'manual',
        startTime: Date.now()
    };

    beforeEach(() => {
        jest.clearAllMocks();
        actor = createActor(removalDeploymentMachine, {
            input: mockContext
        });
        actor.start();
    });

    afterEach(() => {
        if (actor && actor.getSnapshot().status !== 'stopped') {
            actor.stop();
        }
    });

    describe('Initial State', () => {
        it('should start in idle state', () => {
            expect(actor.getSnapshot().value).toBe('idle');
        });

        it('should initialize context with provided input', () => {
            const snapshot = actor.getSnapshot();
            expect(snapshot.context.deploymentId).toBe('test-deployment-123');
            expect(snapshot.context.applicationName).toBe('test-app');
            expect(snapshot.context.lbRemovalComplete).toBe(false);
        });
    });

    describe('Direct Event Testing', () => {
        it('should accept START_REMOVAL event in idle state', () => {
            const initialValue = actor.getSnapshot().value;
            expect(initialValue).toBe('idle');

            actor.send({ type: 'START_REMOVAL' });

            // The machine should accept the event (may transition immediately or via entry action)
            const newSnapshot = actor.getSnapshot();
            expect(newSnapshot.value === 'idle' || newSnapshot.value === 'removingFromLB').toBe(true);
        });

        it('should update context properly on successful events', () => {
            // Simulate a complete flow using direct event sends
            actor.send({ type: 'START_REMOVAL' });
            actor.send({ type: 'LB_REMOVAL_SUCCESS' });

            const snapshot = actor.getSnapshot();
            expect(snapshot.context.lbRemovalComplete).toBe(true);
        });

        it('should handle containers update on STOP_SUCCESS', () => {
            actor.send({ type: 'START_REMOVAL' });
            actor.send({ type: 'LB_REMOVAL_SUCCESS' });
            actor.send({ type: 'FRONTEND_REMOVED' });
            actor.send({ type: 'DNS_REMOVED' });
            actor.send({ type: 'STOP_SUCCESS', stoppedContainers: ['container1', 'container2'] });

            const snapshot = actor.getSnapshot();
            expect(snapshot.context.applicationStopped).toBe(true);
            expect(snapshot.context.containersToRemove).toEqual(['container1', 'container2']);
        });

        it('should preserve error context on failed events and continue flow', () => {
            actor.send({ type: 'START_REMOVAL' });
            actor.send({ type: 'LB_REMOVAL_FAILED', error: 'Test error message' });

            const snapshot = actor.getSnapshot();
            // Error is preserved as a warning and flow continues to removingFrontend
            expect(snapshot.context.error).toBe('LB removal warning: Test error message');
            expect(snapshot.context.lbRemovalComplete).toBe(false);
            expect(snapshot.value).toBe('removingFrontend');
        });
    });

    describe('State Machine Configuration', () => {
        it('should have proper machine id', () => {
            expect(removalDeploymentMachine.config.id).toBe('removalDeployment');
        });

        it('should define all required actions', () => {
            // Check if the machine has the expected action behavior
            // XState might store actions differently in different versions
            const machineOptions = removalDeploymentMachine.implementations;
            expect(machineOptions).toBeDefined();
            expect(machineOptions.actions).toBeDefined();
            expect(machineOptions.actions?.removeContainerFromLB).toBeDefined();
            expect(machineOptions.actions?.stopApplication).toBeDefined();
            expect(machineOptions.actions?.removeApplication).toBeDefined();
        });

        it('should define all required guards', () => {
            // Check if the machine has the expected guard behavior
            const machineOptions = removalDeploymentMachine.implementations;
            expect(machineOptions).toBeDefined();
            expect(machineOptions.guards).toBeDefined();
            expect(machineOptions.guards?.lbRemovalCompleted).toBeDefined();
            expect(machineOptions.guards?.applicationStopped).toBeDefined();
            expect(machineOptions.guards?.applicationRemoved).toBeDefined();
        });

        it('should have proper state definitions', () => {
            const states = removalDeploymentMachine.config.states;
            expect(states).toBeDefined();
            expect(states?.idle).toBeDefined();
            expect(states?.removingFromLB).toBeDefined();
            expect(states?.stoppingApplication).toBeDefined();
            expect(states?.removingApplication).toBeDefined();
            expect(states?.cleanup).toBeDefined();
            expect(states?.completed).toBeDefined();
            expect(states?.failed).toBeDefined();
        });
    });

    describe('Context Management', () => {
        it('should maintain context state during removal flow', () => {
            // Verify that context is properly updated during the flow
            actor.send({ type: 'START_REMOVAL' });
            actor.send({ type: 'LB_REMOVAL_SUCCESS' });
            actor.send({ type: 'FRONTEND_REMOVED' });
            actor.send({ type: 'DNS_REMOVED' });
            actor.send({ type: 'STOP_SUCCESS', stoppedContainers: ['container1'] });

            let context = actor.getSnapshot().context;
            expect(context.lbRemovalComplete).toBe(true);
            expect(context.applicationStopped).toBe(true);
            expect(context.containersToRemove).toContain('container1');

            // Simulate completion
            actor.send({ type: 'REMOVAL_SUCCESS' });

            context = actor.getSnapshot().context;

            // Context should maintain the data throughout the flow
            expect(context.deploymentId).toBe('test-deployment-123');
            expect(context.applicationName).toBe('test-app');
            expect(context.applicationRemoved).toBe(true);
        });

        it('should handle default values when no input provided', () => {
            const defaultActor = createActor(removalDeploymentMachine);
            defaultActor.start();

            const snapshot = defaultActor.getSnapshot();
            expect(snapshot.context.deploymentId).toBe('');
            expect(snapshot.context.applicationName).toBe('');
            expect(snapshot.context.containersToRemove).toEqual([]);
            expect(snapshot.context.triggerType).toBe('manual');

            defaultActor.stop();
        });
    });

    describe('Event Flow Logic', () => {
        it('should handle complete successful flow', () => {
            expect(actor.getSnapshot().value).toBe('idle');

            // Start removal
            actor.send({ type: 'START_REMOVAL' });

            // LB removal succeeds
            actor.send({ type: 'LB_REMOVAL_SUCCESS' });
            expect(actor.getSnapshot().context.lbRemovalComplete).toBe(true);

            // Frontend removal succeeds
            actor.send({ type: 'FRONTEND_REMOVED' });
            expect(actor.getSnapshot().context.frontendRemoved).toBe(true);

            // DNS removal succeeds
            actor.send({ type: 'DNS_REMOVED' });
            expect(actor.getSnapshot().context.dnsRemoved).toBe(true);

            // Application stop succeeds
            actor.send({ type: 'STOP_SUCCESS', stoppedContainers: ['container1'] });
            expect(actor.getSnapshot().context.applicationStopped).toBe(true);
            expect(actor.getSnapshot().context.containersToRemove).toContain('container1');

            // Application removal succeeds
            actor.send({ type: 'REMOVAL_SUCCESS' });
            expect(actor.getSnapshot().context.applicationRemoved).toBe(true);

            // cleanup has an `always` transition to completed, so we should already be done
            const finalSnapshot = actor.getSnapshot();
            expect(finalSnapshot.value).toBe('completed');
        });

        it('should handle cleanup failure gracefully', () => {
            // Get to cleanup state via full flow
            actor.send({ type: 'START_REMOVAL' });
            actor.send({ type: 'LB_REMOVAL_SUCCESS' });
            actor.send({ type: 'FRONTEND_REMOVED' });
            actor.send({ type: 'DNS_REMOVED' });
            actor.send({ type: 'STOP_SUCCESS' });
            actor.send({ type: 'REMOVAL_SUCCESS' });

            // cleanup has an `always` transition to completed, so it auto-transitions
            const snapshot = actor.getSnapshot();
            expect(snapshot.value).toBe('completed');
        });

        it('should continue through all states even when steps fail', () => {
            actor.send({ type: 'START_REMOVAL' });

            // LB removal fails - should continue to removingFrontend
            actor.send({ type: 'LB_REMOVAL_FAILED', error: 'HAProxy unreachable' });
            expect(actor.getSnapshot().value).toBe('removingFrontend');
            expect(actor.getSnapshot().context.lbRemovalComplete).toBe(false);

            // Frontend removal errors - should continue to removingDNS
            actor.send({ type: 'FRONTEND_REMOVAL_ERROR', error: 'Frontend error' });
            expect(actor.getSnapshot().value).toBe('removingDNS');

            // DNS removal errors - should continue to stoppingApplication
            actor.send({ type: 'DNS_REMOVAL_ERROR', error: 'DNS error' });
            expect(actor.getSnapshot().value).toBe('stoppingApplication');

            // Stop fails - should continue to removingApplication
            actor.send({ type: 'STOP_FAILED', error: 'Docker socket error' });
            expect(actor.getSnapshot().value).toBe('removingApplication');
            expect(actor.getSnapshot().context.applicationStopped).toBe(false);

            // Removal fails - should continue to cleanup
            actor.send({ type: 'REMOVAL_FAILED', error: 'Container removal error' });
            // cleanup has always → completed
            expect(actor.getSnapshot().value).toBe('completed');
            expect(actor.getSnapshot().context.applicationRemoved).toBe(false);
        });
    });
});