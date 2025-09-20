# HAProxy Initial Deployment Actions Implementation Plan

## Useful Context Files

### Core Files to Reference
- `/server/src/services/haproxy/initial-deployment-state-machine.ts` - Main state machine definition
- `/server/src/services/haproxy/actions/*.ts` - All action stub files to implement
- `/server/src/services/deployment-orchestrator.ts` - Deployment orchestrator that uses the state machine
- `/server/src/routes/deployments.ts` - API endpoints that trigger deployments

### Service Dependencies
- `/server/src/services/docker.ts` - Docker service for container management
- `/server/src/services/container-lifecycle-manager.ts` - Container lifecycle management
- `/server/src/services/health-check.ts` - Health check service
- `/server/src/services/environment-validation.ts` - Environment validation and HAProxy context
- `/server/src/services/haproxy/haproxy-service.ts` - HAProxy service configuration

### Configuration Files
- `/server/docker-compose/haproxy/dataplaneapi.yml` - HAProxy DataPlane API configuration
- `/server/docker-compose/haproxy/haproxy.cfg` - HAProxy base configuration
- `/lib/types/deployments.ts` - TypeScript types for deployments

### Frontend Context
- `/client/src/app/deployments/page.tsx` - Deployments page
- `/client/src/components/deployments/deployment-list.tsx` - Deploy button component
- `/client/src/hooks/use-deployment-trigger.ts` - Deployment trigger hook

---

## Implementation Plan

### Phase 1: Create HAProxy DataPlane API Client

#### New File: `/server/src/services/haproxy/haproxy-dataplane-client.ts`

**Purpose**: Service to interact with HAProxy DataPlane API

**Key Features**:
- Discover HAProxy container and API endpoint dynamically from environment context
- Authenticate using credentials from `dataplaneapi.yml` (admin/adminpwd)
- Support transactional configuration changes
- Implement retry logic for API calls

**Core Methods**:
```typescript
class HAProxyDataPlaneClient {
  // Discovery
  private async discoverHAProxyEndpoint(containerId: string): Promise<string>

  // Backend Management
  async createBackend(name: string, mode: string): Promise<void>
  async deleteBackend(name: string): Promise<void>
  async getBackend(name: string): Promise<Backend | null>

  // Server Management
  async addServer(backend: string, server: ServerConfig): Promise<void>
  async enableServer(backend: string, server: string): Promise<void>
  async disableServer(backend: string, server: string): Promise<void>
  async setServerState(backend: string, server: string, state: string): Promise<void>

  // Frontend Management
  async createFrontend(config: FrontendConfig): Promise<void>
  async addFrontendRule(frontend: string, rule: Rule): Promise<void>

  // Health & Stats
  async getServerStats(backend: string, server: string): Promise<ServerStats>
  async getBackendStats(backend: string): Promise<BackendStats>

  // Configuration Management
  async beginTransaction(): Promise<string>
  async commitTransaction(transactionId: string): Promise<void>
  async rollbackTransaction(transactionId: string): Promise<void>
}
```

---

### Phase 2: Implement Core Deployment Actions

#### 1. `deploy-application-containers.ts`

**Responsibilities**:
- Create application container using `ContainerLifecycleManager`
- Connect container to HAProxy network (from context)
- Apply deployment configuration (ports, volumes, env vars)
- Add tracking labels (mini-infra.application, mini-infra.environment, etc.)

**Implementation Steps**:
1. Extract deployment configuration from context
2. Prepare container configuration with network settings
3. Create container using ContainerLifecycleManager
4. Start container
5. Emit DEPLOYMENT_SUCCESS with containerId or DEPLOYMENT_ERROR

**Key Considerations**:
- Ensure container is on the same network as HAProxy
- Add proper labels for tracking and cleanup
- Handle Docker API errors gracefully

#### 2. `monitor-container-startup.ts`

**Responsibilities**:
- Poll container status until running
- Check container health if health check configured
- Implement timeout handling (2 minutes default)

**Implementation Steps**:
1. Get container instance from Docker API
2. Set up polling interval (every 2 seconds)
3. Check container state and health status
4. Clear interval on success/failure
5. Emit CONTAINERS_RUNNING or STARTUP_TIMEOUT

**Key Considerations**:
- Handle container restart scenarios
- Check both running state and health status
- Clean timeout handling to prevent memory leaks

#### 3. `add-container-to-lb.ts`

**Responsibilities**:
- Get container IP address from Docker network
- Create HAProxy backend if not exists
- Add server to backend with proper configuration
- Configure health checks in HAProxy

**Implementation Steps**:
1. Initialize HAProxyDataPlaneClient with discovered endpoint
2. Get container network IP address
3. Check if backend exists, create if not
4. Prepare server configuration with health check
5. Add server to backend in disabled state initially
6. Emit LB_CONFIGURED or LB_CONFIG_ERROR

**Server Configuration Example**:
```javascript
{
  name: `${applicationName}-${containerId.slice(0,8)}`,
  address: containerIP,
  port: listeningPort || 80,
  check: 'enabled',
  check_path: healthCheckConfig.endpoint,
  inter: healthCheckConfig.interval,
  rise: 2,
  fall: 3,
  maintenance: false,
  enabled: false  // Start disabled, enable after health checks
}
```

#### 4. `perform-health-checks.ts`

**Responsibilities**:
- Execute health checks against container
- Validate responses according to configuration
- Support both direct and HAProxy-mediated checks

**Implementation Steps**:
1. Use HealthCheckService for direct container checks
2. Query HAProxy for server health status
3. Validate response patterns if configured
4. Retry with configured intervals
5. Emit SERVERS_HEALTHY or HEALTH_CHECK_TIMEOUT

**Health Check Flow**:
- Direct check: HTTP request to container endpoint
- HAProxy check: Query server status via DataPlane API
- Validate: Status codes, response body, response time

#### 5. `enable-traffic.ts`

**Responsibilities**:
- Enable server in HAProxy backend
- Update frontend rules if needed
- Apply configuration atomically

**Implementation Steps**:
1. Begin HAProxy transaction
2. Enable server in backend
3. Update frontend rules if required
4. Commit transaction
5. Emit TRAFFIC_ENABLED or TRAFFIC_ENABLE_FAILED

**Frontend Rule Configuration**:
- Path-based routing
- Host-based routing
- Default backend assignment

---

### Phase 3: Implement Supporting Actions

#### 6. `validate-traffic.ts`

**Responsibilities**:
- Monitor initial traffic flow
- Check error rates and response times
- Validate against thresholds

**Implementation**:
- Query HAProxy stats API
- Calculate error rates
- Monitor response times
- Check against configured thresholds

#### 7. `cleanup-temp-resources.ts`

**Responsibilities**:
- Remove temporary containers from failed attempts
- Clean up orphaned resources
- Update deployment records

**Implementation**:
- Identify temporary resources by labels
- Remove failed containers
- Clean up unused network connections
- Update database status

#### 8. `alert-operations-team.ts`

**Responsibilities**:
- Log comprehensive failure information
- Update deployment status in database
- Send notifications if configured

**Implementation**:
- Aggregate error information from context
- Create detailed failure report
- Update deployment record with failure details
- Trigger notification system (if available)

#### 9. `log-deployment-success.ts`

**Responsibilities**:
- Record successful deployment metrics
- Update deployment status
- Clean up old artifacts

**Implementation**:
- Calculate deployment duration
- Update deployment record as completed
- Log success metrics
- Trigger post-deployment cleanup if needed

---

### Phase 4: Integration Considerations

#### Network Management
- All containers MUST be connected to the HAProxy network
- Network name comes from environment context (`haproxyNetworkName`)
- Health check containers also run on same network

#### HAProxy Discovery
- HAProxy container ID comes from environment context (`haproxyContainerId`)
- DataPlane API endpoint: `http://<container_name>:5555`
- Use container inspect to get container name

#### Error Handling
- Each action must properly emit error events
- Include detailed error context for debugging
- Ensure cleanup on failure
- Implement retry logic where appropriate

#### State Machine Events
- SUCCESS events must include required data (containerId, etc.)
- ERROR events must include error message
- Timing events handled by state machine guards

#### Database Updates
- Update deployment steps during execution
- Record health check results
- Track container IDs for rollback
- Store error details for debugging

---

### Phase 5: Testing Strategy

#### Unit Tests
- Mock Docker API responses
- Mock HAProxy DataPlane API
- Test error scenarios
- Validate event emissions

#### Integration Tests
- Test with real Docker daemon
- Test with HAProxy test instance
- Validate network connectivity
- Test health check scenarios

#### End-to-End Tests
- Full deployment flow
- Rollback scenarios
- Network failure handling
- HAProxy configuration validation

---

### Implementation Priority

1. **High Priority** (Required for basic functionality):
   - HAProxyDataPlaneClient
   - deploy-application-containers
   - monitor-container-startup
   - add-container-to-lb
   - perform-health-checks
   - enable-traffic

2. **Medium Priority** (Required for production):
   - validate-traffic
   - alert-operations-team
   - log-deployment-success

3. **Low Priority** (Nice to have):
   - cleanup-temp-resources
   - Advanced monitoring
   - Notification integrations

---

### Security Considerations

- Store HAProxy API credentials securely
- Use authentication for DataPlane API
- Validate all input parameters
- Sanitize container names and labels
- Implement rate limiting for API calls
- Audit log all configuration changes

---

### Performance Considerations

- Cache HAProxy configuration queries
- Batch DataPlane API calls where possible
- Use transactions for atomic changes
- Implement connection pooling
- Optimize health check intervals
- Monitor resource usage

---

### Rollback Strategy

- Keep track of previous configuration
- Store old container IDs
- Implement automatic rollback triggers
- Support manual rollback command
- Preserve old containers if configured
- Maintain rollback history

---

## Next Steps

1. Create HAProxyDataPlaneClient service
2. Implement deploy-application-containers action
3. Test basic container deployment flow
4. Implement remaining actions iteratively
5. Add comprehensive error handling
6. Write unit and integration tests
7. Document API usage and patterns
8. Performance optimization
9. Security hardening
10. Production readiness review