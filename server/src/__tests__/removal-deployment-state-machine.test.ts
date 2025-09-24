import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createActor } from 'xstate';
import { removalDeploymentMachine } from '../services/haproxy/removal-deployment-state-machine';

// Mock all action classes to prevent actual execution
jest.mock('../services/haproxy/actions/remove-container-from-lb');
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
            actor.send({ type: 'STOP_SUCCESS', stoppedContainers: ['container1', 'container2'] });

            const snapshot = actor.getSnapshot();
            expect(snapshot.context.applicationStopped).toBe(true);
            expect(snapshot.context.containersToRemove).toEqual(['container1', 'container2']);
        });

        it('should preserve error context on failed events', () => {
            actor.send({ type: 'START_REMOVAL' });
            actor.send({ type: 'LB_REMOVAL_FAILED', error: 'Test error message' });

            const snapshot = actor.getSnapshot();
            expect(snapshot.context.error).toBe('Test error message');
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
            actor.send({ type: 'STOP_SUCCESS', stoppedContainers: ['container1'] });

            let context = actor.getSnapshot().context;
            expect(context.lbRemovalComplete).toBe(true);
            expect(context.applicationStopped).toBe(true);
            expect(context.containersToRemove).toContain('container1');

            // Simulate completion
            actor.send({ type: 'REMOVAL_SUCCESS' });
            actor.send({ type: 'CLEANUP_SUCCESS' });

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

            // Application stop succeeds
            actor.send({ type: 'STOP_SUCCESS', stoppedContainers: ['container1'] });
            expect(actor.getSnapshot().context.applicationStopped).toBe(true);
            expect(actor.getSnapshot().context.containersToRemove).toContain('container1');

            // Application removal succeeds
            actor.send({ type: 'REMOVAL_SUCCESS' });
            expect(actor.getSnapshot().context.applicationRemoved).toBe(true);

            // Cleanup succeeds
            actor.send({ type: 'CLEANUP_SUCCESS' });
            // Should reach some final state
            const finalSnapshot = actor.getSnapshot();
            expect(finalSnapshot.value === 'completed' || finalSnapshot.done).toBe(true);
        });

        it('should handle cleanup failure gracefully', () => {
            // Get to cleanup state
            actor.send({ type: 'START_REMOVAL' });
            actor.send({ type: 'LB_REMOVAL_SUCCESS' });
            actor.send({ type: 'STOP_SUCCESS' });
            actor.send({ type: 'REMOVAL_SUCCESS' });

            // Cleanup fails but should not fail entire process
            actor.send({ type: 'CLEANUP_FAILED', error: 'Cleanup failed' });

            const snapshot = actor.getSnapshot();
            // Should still complete but with warning - the main point is it doesn't fail
            expect(snapshot.value === 'completed' || snapshot.done).toBe(true);
            // The state machine should handle the cleanup failure gracefully
            // and continue to completion (this is the key behavior we're testing)
        });
    });
});