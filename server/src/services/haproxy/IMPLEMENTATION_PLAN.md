# Initial Deployment State Machine Actions - Implementation Plan

## Relevant Files to Read

### Core State Machine
- `/server/src/services/haproxy/initial-deployment-state-machine.ts` - The state machine definition with states and transitions
- `/server/src/services/deployment-orchestrator.ts` - How the state machine is instantiated and managed

### Action Stub Files (to be implemented)
- `/server/src/services/haproxy/actions/deploy-application-containers.ts`
- `/server/src/services/haproxy/actions/monitor-container-startup.ts`
- `/server/src/services/haproxy/actions/add-container-to-lb.ts`
- `/server/src/services/haproxy/actions/perform-health-checks.ts`
- `/server/src/services/haproxy/actions/enable-traffic.ts`
- `/server/src/services/haproxy/actions/validate-traffic.ts`
- `/server/src/services/haproxy/actions/log-deployment-success.ts`
- `/server/src/services/haproxy/actions/alert-operations-team.ts`
- `/server/src/services/haproxy/actions/cleanup-temp-resources.ts`

### Service Dependencies
- `/server/src/services/haproxy/haproxy-dataplane-client.ts` - HAProxy DataPlane API client for load balancer configuration
- `/server/src/services/container-lifecycle-manager.ts` - Docker container creation and management
- `/server/src/services/docker.ts` - Docker service for container operations
- `/server/src/services/environment-manager.ts` - Environment management and validation
- `/server/src/services/environment-validation.ts` - HAProxy environment context validation

### Type Definitions
- `/lib/types/deployment.types.ts` - Deployment configuration types
- `/lib/types/container.types.ts` - Container configuration types

### Logging
- `/server/src/lib/logger-factory.ts` - Logger factory for creating domain-specific loggers

## Overview
The initial deployment state machine needs to orchestrate the deployment of a new application into an HAProxy-managed environment. The actions need to:
1. Deploy containers to the same network as HAProxy
2. Configure HAProxy backend and servers
3. Use HAProxy's built-in health checking
4. Enable and validate traffic

## Implementation Strategy

### 1. DeployApplicationContainers Action
**Status: COMPLETED**

**Purpose**: Create and start the application container

**Implementation Details**:
- Use ContainerLifecycleManager to create container
- Attach to the same network as HAProxy (haproxyNetworkName from context)
- Add appropriate labels for tracking
- Return container ID via callback to update context
- Send DEPLOYMENT_SUCCESS or DEPLOYMENT_ERROR event

### 2. MonitorContainerStartup Action
**Status: COMPLETED**

**Purpose**: Ensure container is running and ready

**Implementation Details**:
- Poll container status using ContainerLifecycleManager
- Check if container state is "running"
- Get container's network IP address for HAProxy configuration
- Send CONTAINERS_RUNNING or STARTUP_TIMEOUT event
- Use async polling with timeout (2 minutes as defined in state machine)

### 3. AddContainerToLB Action
**Status: PENDING**

**Purpose**: Configure HAProxy backend and server

**Implementation Details**:
- Initialize HAProxyDataPlaneClient with haproxyContainerId
- Create backend if it doesn't exist (named after applicationName)
- Add server with container's IP address
- Configure health checks via HAProxy (using check_path from config)
- Send LB_CONFIGURED or LB_CONFIG_ERROR event

### 4. PerformHealthChecks Action
**Status: PENDING**

**Purpose**: Monitor HAProxy's health check results

**Implementation Details**:
- Use HAProxyDataPlaneClient.getServerStats() to check server health
- Poll until server status becomes "UP" in HAProxy
- HAProxy performs the actual health checking (no direct container checks needed)
- Send SERVERS_HEALTHY or HEALTH_CHECK_TIMEOUT event
- Timeout after 90 seconds as defined in state machine

### 5. EnableTraffic Action
**Status: PENDING**

**Purpose**: Enable the server in HAProxy backend

**Implementation Details**:
- Use HAProxyDataPlaneClient.enableServer() or setServerState('ready')
- Verify server is accepting traffic
- Send TRAFFIC_ENABLED or TRAFFIC_ENABLE_FAILED event

### 6. ValidateTraffic Action
**Status: PENDING**

**Purpose**: Monitor traffic stability

**Implementation Details**:
- Poll HAProxy backend/server statistics
- Check for error rates, response times
- Track validation errors in context
- Send TRAFFIC_STABLE or CRITICAL_ISSUES event
- Run for 30 seconds minimum as defined in state machine

### 7. LogDeploymentSuccess Action
**Status: PENDING**

**Purpose**: Log successful deployment

**Implementation Details**:
- Log comprehensive deployment summary
- Record metrics (deployment time, container ID, etc.)
- Update database records if needed

### 8. AlertOperationsTeam Action
**Status: PENDING**

**Purpose**: Handle deployment failures

**Implementation Details**:
- Log detailed error information
- Could send notifications (email/slack) if configured
- Document failure reason and context

### 9. CleanupTempResources Action
**Status: PENDING**

**Purpose**: Clean up any temporary resources

**Implementation Details**:
- Remove any temporary configuration files
- Clean up failed container attempts if any
- Reset any temporary state

## Key Technical Details

### Action Structure Pattern
Each action will follow this pattern:
```typescript
export class ActionName {
  private haproxyClient: HAProxyDataPlaneClient;
  private containerManager: ContainerLifecycleManager;

  async execute(context: any, callback: (event: any) => void): Promise<void> {
    try {
      // Perform action logic
      // Send success event via callback
      callback({ type: 'SUCCESS_EVENT', data });
    } catch (error) {
      // Send error event via callback
      callback({ type: 'ERROR_EVENT', error: error.message });
    }
  }
}
```

### HAProxy Health Check Configuration
- Use HAProxy's built-in health checking by configuring:
  - `check: 'enabled'` on the server
  - `check_path: '/health'` or from deployment config
  - `inter: 2000` (2 second intervals)
  - `rise: 2` (2 successful checks to mark UP)
  - `fall: 3` (3 failed checks to mark DOWN)

### Network Configuration
- Container must join the same Docker network as HAProxy
- Use container's internal IP address for HAProxy backend server
- No port binding needed on host (traffic goes through HAProxy)

### Context Updates
Actions will need to update context via callbacks to track:
- containerId: Set after successful container deployment
- applicationReady: Set when container is running
- haproxyConfigured: Set when backend/server added
- healthChecksPassed: Set when HAProxy reports server UP
- trafficEnabled: Set when server enabled in HAProxy

## Implementation Order
1. Start with DeployApplicationContainers (core container creation)
2. Implement MonitorContainerStartup (verify container running)
3. Implement AddContainerToLB (HAProxy configuration)
4. Implement PerformHealthChecks (HAProxy health monitoring)
5. Implement EnableTraffic (activate server)
6. Implement ValidateTraffic (stability monitoring)
7. Implement success/failure handlers (logging, alerts, cleanup)

## Testing Strategy
- Unit tests for each action with mocked dependencies
- Integration tests with real Docker and HAProxy containers
- Test failure scenarios (container fails to start, health checks fail, etc.)
- Verify proper event emission and state transitions

## Notes on XState Integration

### Event Callback Pattern
Actions need to communicate back to the state machine using callbacks. The state machine expects specific events to transition between states:

- `DEPLOYMENT_SUCCESS` / `DEPLOYMENT_ERROR` from DeployApplicationContainers
- `CONTAINERS_RUNNING` / `STARTUP_TIMEOUT` from MonitorContainerStartup
- `LB_CONFIGURED` / `LB_CONFIG_ERROR` from AddContainerToLB
- `SERVERS_HEALTHY` / `HEALTH_CHECK_TIMEOUT` from PerformHealthChecks
- `TRAFFIC_ENABLED` / `TRAFFIC_ENABLE_FAILED` from EnableTraffic
- `TRAFFIC_STABLE` / `CRITICAL_ISSUES` from ValidateTraffic

### Async Action Execution
Since XState actions in the current setup are synchronous but need to perform async operations, we'll need to:
1. Convert actions to use invoked services (fromPromise) in the state machine
2. OR have actions start async processes that send events back via the actor reference

### Dependencies Required
- HAProxyDataPlaneClient for HAProxy API interactions
- ContainerLifecycleManager for Docker container operations
- DockerService for getting container network information
- Logger instances for comprehensive logging

## Progress Tracking
Last Updated: [Current Date]

### Completed Actions
- None

### In Progress
- None

### Blocked/Issues
- None