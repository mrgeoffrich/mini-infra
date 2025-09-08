import { createActor, fromPromise } from "xstate";
import { deploymentStateMachine, DeploymentContext, DeploymentEvent } from "../deployment-state-machine";
import { DeploymentConfig } from "@mini-infra/types";

// Mock the logger to avoid console output during tests
jest.mock("../../lib/logger-factory", () => ({
  deploymentLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe("DeploymentStateMachine", () => {
  // Test data
  const mockDeploymentConfig: DeploymentConfig = {
    applicationName: "test-app",
    dockerImage: "nginx",
    dockerTag: "latest",
    containerConfig: {
      ports: [{ containerPort: 80, hostPort: 8080 }],
      environment: {},
      volumes: [],
      healthCheck: {
        enabled: true,
        command: "curl -f http://localhost/ || exit 1",
        interval: 30,
        timeout: 10,
        retries: 3,
        startPeriod: 0,
      },
    },
    healthCheck: {
      enabled: true,
      endpoint: "/health",
      method: "GET",
      expectedStatus: [200],
      timeout: 10000,
      interval: 5000,
      retries: 3,
      responseValidation: null,
    },
    traefikConfig: {
      routerName: "test-app",
      serviceName: "test-app-service",
      rule: "Host(`test.local`)",
      tls: false,
      middlewares: [],
    },
    rollbackConfig: {
      enabled: true,
      keepOldContainer: false,
      autoRollback: true,
      healthCheckTimeout: 300000,
    },
  };

  const createInitialContext = (overrides: Partial<DeploymentContext> = {}): DeploymentContext => ({
    deploymentId: "test-deployment-123",
    configurationId: "config-456",
    config: mockDeploymentConfig,
    triggerType: "manual",
    triggeredBy: "test-user",
    dockerImage: "nginx:latest",
    oldContainerId: null,
    newContainerId: null,
    targetColor: "blue",
    currentStep: "idle",
    steps: [],
    startTime: Date.now(),
    healthCheckPassed: false,
    healthCheckLogs: [],
    errorMessage: null,
    errorDetails: null,
    retryCount: 0,
    maxRetries: 3,
    deploymentTime: null,
    downtime: 0,
    ...overrides,
  });

  describe("Context Initialization and Preservation", () => {
    test("should initialize with provided context", () => {
      const initialContext = createInitialContext();
      
      // Create state machine with provided actors (mocked)
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.resolve({ success: true })),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-123" })),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      actor.start();
      const state = actor.getSnapshot();

      // Verify initial context is preserved
      expect(state.context.deploymentId).toBe("test-deployment-123");
      expect(state.context.configurationId).toBe("config-456");
      expect(state.context.triggerType).toBe("manual");
      expect(state.context.triggeredBy).toBe("test-user");
      expect(state.context.dockerImage).toBe("nginx:latest");
      expect(state.context.targetColor).toBe("blue");
      expect(state.context.maxRetries).toBe(3);
      expect(state.context.retryCount).toBe(0);
    });

    test("should preserve context through state transitions", () => {
      const initialContext = createInitialContext();
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.resolve({ success: true })),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-123" })),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      actor.start();

      // Send START_DEPLOYMENT event
      actor.send({ type: "START_DEPLOYMENT" });
      
      const state = actor.getSnapshot();
      
      // Context should be preserved and currentStep should be updated
      expect(state.context.deploymentId).toBe("test-deployment-123");
      expect(state.context.configurationId).toBe("config-456");
      expect(state.context.currentStep).toBe("preparing");
    });
  });

  describe("Context Mutations via Assign Actions", () => {
    test("should update currentStep when entering states", async () => {
      const initialContext = createInitialContext();
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => new Promise(() => {})), // Never resolves, stays in preparing
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-123" })),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      actor.start();
      expect(actor.getSnapshot().context.currentStep).toBe("");

      // Start deployment
      actor.send({ type: "START_DEPLOYMENT" });
      
      // Wait for state transition
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const state = actor.getSnapshot();
      expect(state.context.currentStep).toBe("preparing");
      expect(state.value).toBe("preparing");
    });

    test("should set newContainerId from event output", async () => {
      const initialContext = createInitialContext();
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.resolve({ success: true })),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-abc123" })),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      const states: any[] = [];
      actor.subscribe((state) => {
        states.push({
          value: state.value,
          context: { ...state.context },
        });
      });

      actor.start();
      actor.send({ type: "START_DEPLOYMENT" });

      // Wait for deployment to progress
      await new Promise(resolve => setTimeout(resolve, 100));

      // Find the state where newContainerId should be set
      const deployingCompletedState = states.find(s => 
        s.context.newContainerId === "container-abc123"
      );

      expect(deployingCompletedState).toBeDefined();
      expect(deployingCompletedState.context.newContainerId).toBe("container-abc123");
    });

    test("should increment retry count on health check failure", async () => {
      const initialContext = createInitialContext();
      
      let healthCheckCallCount = 0;
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.resolve({ success: true })),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-123" })),
          performHealthChecks: fromPromise(() => {
            healthCheckCallCount++;
            if (healthCheckCallCount <= 2) {
              return Promise.reject(new Error("Health check failed"));
            }
            return Promise.resolve({ success: true });
          }),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      const states: any[] = [];
      actor.subscribe((state) => {
        states.push({
          value: state.value,
          context: { ...state.context },
        });
      });

      actor.start();
      actor.send({ type: "START_DEPLOYMENT" });

      // Wait for retries to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Check retry count progression
      const retryStates = states.filter(s => s.context.retryCount > 0);
      expect(retryStates.length).toBeGreaterThan(0);
      
      // Should have incremented retry count
      const maxRetryCount = Math.max(...states.map(s => s.context.retryCount));
      expect(maxRetryCount).toBeGreaterThan(0);
      expect(maxRetryCount).toBeLessThanOrEqual(3);
    });
  });

  describe("Error Handling and Context Updates", () => {
    test("should set error message on image pull failure", async () => {
      const initialContext = createInitialContext();
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.reject(new Error("Image not found"))),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-123" })),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      const states: any[] = [];
      actor.subscribe((state) => {
        states.push({
          value: state.value,
          context: { ...state.context },
        });
      });

      actor.start();
      actor.send({ type: "START_DEPLOYMENT" });

      // Wait for failure to occur
      await new Promise(resolve => setTimeout(resolve, 50));

      const failedState = states.find(s => s.value === "failed");
      expect(failedState).toBeDefined();
      expect(failedState.context.errorMessage).toContain("Failed to pull image");
      expect(failedState.context.errorMessage).toContain("Image not found");
      expect(failedState.context.currentStep).toBe("failed");
    });

    test("should set error message on container creation failure", async () => {
      const initialContext = createInitialContext();
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.resolve({ success: true })),
          createAndStartContainer: fromPromise(() => Promise.reject(new Error("Container creation failed"))),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      const states: any[] = [];
      actor.subscribe((state) => {
        states.push({
          value: state.value,
          context: { ...state.context },
        });
      });

      actor.start();
      actor.send({ type: "START_DEPLOYMENT" });

      // Wait for failure to occur
      await new Promise(resolve => setTimeout(resolve, 50));

      const failedState = states.find(s => s.value === "failed");
      expect(failedState).toBeDefined();
      expect(failedState.context.errorMessage).toContain("Failed to create/start container");
      expect(failedState.context.errorMessage).toContain("Container creation failed");
    });
  });

  describe("Guard Evaluations", () => {
    test("maxRetriesReached guard should work with context", async () => {
      const initialContext = createInitialContext({ 
        retryCount: 3, 
        maxRetries: 3 
      });
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.resolve({ success: true })),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-123" })),
          performHealthChecks: fromPromise(() => Promise.reject(new Error("Health check failed"))),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      const states: any[] = [];
      actor.subscribe((state) => {
        states.push({
          value: state.value,
          context: { ...state.context },
        });
      });

      actor.start();
      actor.send({ type: "START_DEPLOYMENT" });

      // Wait for health check failure
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should go to failed state due to max retries reached
      const finalState = actor.getSnapshot();
      expect(finalState.value).toBe("failed");
      expect(finalState.context.retryCount).toBe(3);
    });

    test("canRetry guard should work with context", async () => {
      const initialContext = createInitialContext({ 
        retryCount: 1, 
        maxRetries: 3 
      });
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.reject(new Error("Image pull failed"))),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-123" })),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      actor.start();

      // Start deployment - it should fail on image pull
      actor.send({ type: "START_DEPLOYMENT" });
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should be in failed state now
      const currentState = actor.getSnapshot();
      expect(currentState.value).toBe("failed");
      
      // Test retry capability - should be true since retryCount (1) < maxRetries (3)
      const canRetryResult = currentState.can({ type: "RETRY" });
      expect(canRetryResult).toBe(true);
    });
  });

  describe("Deployment Time Calculation", () => {
    test("should calculate deployment time correctly", async () => {
      const initialContext = createInitialContext();
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => 
            new Promise(resolve => setTimeout(() => resolve({ success: true }), 50))
          ),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-123" })),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      const states: any[] = [];
      actor.subscribe((state) => {
        states.push({
          value: state.value,
          context: { ...state.context },
        });
      });

      actor.start();
      actor.send({ type: "START_DEPLOYMENT" });

      // Wait for deployment to complete
      await new Promise(resolve => setTimeout(resolve, 150));

      // Find completed state
      const completedState = states.find(s => s.value === "completed");
      if (completedState) {
        expect(completedState.context.deploymentTime).toBeGreaterThan(0);
        expect(completedState.context.deploymentTime).toBeLessThan(60); // Should be less than 60 seconds
      }
    });
  });

  describe("State Machine Flow Integration", () => {
    test("should complete full successful deployment flow with context preservation", async () => {
      const initialContext = createInitialContext();
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.resolve({ success: true })),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-xyz789" })),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: fromPromise(() => Promise.resolve({ success: true })),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      const states: any[] = [];
      actor.subscribe((state) => {
        states.push({
          value: state.value,
          context: { ...state.context },
        });
      });

      actor.start();
      actor.send({ type: "START_DEPLOYMENT" });

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify the flow
      const stateValues = states.map(s => s.value);
      expect(stateValues).toContain("idle");
      expect(stateValues).toContain("preparing");
      expect(stateValues).toContain("deploying");
      expect(stateValues).toContain("health_checking");
      expect(stateValues).toContain("switching_traffic");
      expect(stateValues).toContain("cleanup");
      expect(stateValues).toContain("completed");

      // Verify context preservation throughout
      const finalState = states[states.length - 1];
      expect(finalState.context.deploymentId).toBe("test-deployment-123");
      expect(finalState.context.configurationId).toBe("config-456");
      expect(finalState.context.newContainerId).toBe("container-xyz789");
      expect(finalState.context.healthCheckPassed).toBe(true);
      expect(finalState.context.deploymentTime).toBeGreaterThan(0);
    });

    test("should handle rollback flow with context preservation", async () => {
      const initialContext = createInitialContext();
      
      const machine = deploymentStateMachine.provide({
        actors: {
          pullDockerImage: fromPromise(() => Promise.resolve({ success: true })),
          createAndStartContainer: fromPromise(() => Promise.resolve({ containerId: "container-123" })),
          performHealthChecks: fromPromise(() => Promise.resolve({ success: true })),
          switchTrafficToNewContainer: () => Promise.reject(new Error("Traffic switch failed")),
          cleanupOldContainer: fromPromise(() => Promise.resolve({ success: true })),
          performRollback: fromPromise(() => Promise.resolve({ success: true })),
        },
      });

      const actor = createActor(machine, {
        input: initialContext,
      });

      const states: any[] = [];
      actor.subscribe((state) => {
        states.push({
          value: state.value,
          context: { ...state.context },
        });
      });

      actor.start();
      actor.send({ type: "START_DEPLOYMENT" });

      // Wait for rollback to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify rollback occurred
      const stateValues = states.map(s => s.value);
      expect(stateValues).toContain("rolling_back");
      expect(stateValues).toContain("completed");

      // Verify error context
      const rollbackState = states.find(s => s.value === "rolling_back");
      expect(rollbackState).toBeDefined();
      expect(rollbackState.context.errorMessage).toContain("Failed to switch traffic");
      expect(rollbackState.context.deploymentId).toBe("test-deployment-123");
    });
  });
});