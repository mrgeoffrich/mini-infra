# Zero Downtime Deployment System - Technical Design and Architecture

## 1. Feature Breakdown

### Core Components

- **Deployment Configuration Manager**: Manages per-application deployment settings
- **Traefik Integration Service**: Handles load balancer configuration and traffic routing
- **Deployment Orchestrator**: Coordinates the blue-green deployment workflow
- **Health Check Service**: Validates container health before traffic switching
- **Container Lifecycle Manager**: Manages Docker container creation and cleanup
- **Deployment API**: Webhook endpoints for external deployment triggers
- **Deployment UI**: React components for configuration and monitoring
- **Deployment State Machine**: Manages deployment state transitions
- **Rollback Manager**: Handles failed deployment recovery

## 2. Implementation Considerations

### 2.1 Software Design

#### Deployment Configuration Manager
- **Service Pattern**: Extends `ConfigurationBase` following existing pattern
- **Database Storage**: Prisma models for deployment configurations
- **Configuration Schema**:
  ```typescript
  interface DeploymentConfig {
    applicationName: string
    dockerImage: string
    dockerTag: string
    containerConfig: {
      ports: Port[]
      volumes: Volume[]
      environment: EnvVar[]
      labels: Record<string, string>
      networks: string[]
    }
    healthCheck: {
      endpoint: string
      method: 'GET' | 'POST'
      expectedStatus: number[]
      responseValidation?: string
      timeout: number
      retries: number
      interval: number
    }
    traefikConfig: {
      routerName: string
      serviceName: string
      rule: string // e.g., Host(`app.example.com`)
      middlewares?: string[]
      tls?: boolean
    }
    rollbackConfig: {
      enabled: boolean
      maxWaitTime: number
      keepOldContainer: boolean
    }
  }
  ```

#### Deployment Orchestrator
- **State Machine Pattern**: Event-driven with clear state transitions
- **States**: `idle`, `preparing`, `deploying`, `health_checking`, `switching_traffic`, `cleanup`, `completed`, `failed`, `rolling_back`
- **Event Store**: Database persistence for deployment history and state
- **Async Execution**: Background job processing for long-running operations
- **Progress Tracking**: Real-time updates using existing `ProgressTracker` service
- **Deployment Container Definition**: Use a docker compose format to define the container to run and deploy.
- **Logging**: Add a new logger `app-deployments.log` for the deployment orchestrator logs

#### Traefik Container Setup and Installation
- **System Settings**: Allows configuration of the traefik container in a flexible manner - perhaps like a docker compose yaml. Also define a docker network to put this all on.
- **System Settings API**: Re-use existing API endpoints
- **System Settings UI**: A nice lightweight yaml editor would be good
- **Ongoing management**: This container will be "managed" by this application.

#### Traefik Integration
- **Docker Label Strategy**: Use container labels for Traefik auto-discovery
- **Label Schema**:
  ```yaml
  traefik.enable: "true"
  traefik.http.routers.{app}-blue.rule: "Host(`app.example.com`)"
  traefik.http.routers.{app}-blue.service: "{app}-blue"
  traefik.http.services.{app}-blue.loadbalancer.server.port: "80"
  traefik.http.routers.{app}-blue.priority: "100"  # Higher priority for active
  ```
- **Traffic Switching**: Update container labels to change routing priority
- **Service Discovery**: Automatic detection via Docker events

#### Health Check Service
- **HTTP Client**: Axios with configurable timeout and retry logic
- **Validation Types**:
  - Status code validation
  - Response body pattern matching (regex)
  - Response time thresholds
  - Custom JavaScript validation expressions
- **Circuit Breaker**: Prevent cascading failures during health checks
- **Progressive Health Checking**: Start with basic checks, progress to comprehensive

### 2.2 Software Libraries

#### New Dependencies Required
```json
{
  "dependencies": {
    "axios": "^1.7.0",          // HTTP client for health checks
    "xstate": "^5.18.0",         // State machine library
  }
}
```

#### Existing Libraries to Leverage
- `dockerode`: Container management
- `node-cache`: Caching deployment states
- `pino`: Structured logging for deployment events
- `zod`: Configuration validation
- `prisma`: Database persistence

### 2.3 External Dependencies

- **Docker Engine API**: Container lifecycle management
- **Traefik API**: Optional direct API access for advanced features
- **Docker Registry**: Image pulling and authentication
- **Target Application**: Must expose health check endpoint

### 2.4 Important Flows

#### Deployment Flow
```
1. Trigger (UI/API) → Validate Configuration
2. Pull Docker Image → Verify Image Exists
3. Create New Container (Blue) → Apply Traefik Labels (disabled)
4. Start Container → Wait for Startup
5. Execute Health Checks → Validate Response
6. Update Traefik Labels → Enable Blue, Disable Green
7. Monitor Stability → Check Error Rates
8. Stop Old Container (Green) → Clean Resources
9. Record Deployment → Update History
```

#### Rollback Flow
```
1. Detect Failure → Health Check Failed
2. Restore Traffic → Re-enable Green Container
3. Stop Failed Container → Remove Blue
4. Alert Users → Send Notifications
5. Record Failure → Log Details
```

### 2.5 Database Changes

#### New Prisma Models
```prisma
model DeploymentConfiguration {
  id                String   @id @default(cuid())
  applicationName   String   @unique
  dockerImage       String
  dockerRegistry    String?
  containerConfig   Json     // Ports, volumes, env vars
  healthCheckConfig Json     // Endpoint, validation rules
  traefikConfig     Json     // Routing rules
  rollbackConfig    Json     // Rollback settings
  isActive          Boolean  @default(true)
  userId            String
  user              User     @relation(fields: [userId], references: [id])
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  deployments       Deployment[]
  
  @@index([userId])
  @@map("deployment_configurations")
}

model Deployment {
  id                String   @id @default(cuid())
  configurationId   String
  configuration     DeploymentConfiguration @relation(fields: [configurationId], references: [id])
  triggerType       String   // 'manual', 'webhook', 'scheduled'
  triggeredBy       String?  // User ID or API key ID
  dockerImage       String   // Full image with tag
  status            String   // 'pending', 'deploying', 'health_checking', etc.
  currentState      String   // State machine state
  startedAt         DateTime @default(now())
  completedAt       DateTime?
  
  // Container tracking
  oldContainerId    String?
  newContainerId    String?
  
  // Health check results
  healthCheckPassed Boolean  @default(false)
  healthCheckLogs   Json?
  
  // Error tracking
  errorMessage      String?
  errorDetails      Json?
  
  // Metrics
  deploymentTime    Int?     // Seconds
  downtime          Int      @default(0) // Milliseconds
  
  deploymentSteps   DeploymentStep[]
  
  @@index([configurationId, status])
  @@index([startedAt])
  @@map("deployments")
}

model DeploymentStep {
  id              String   @id @default(cuid())
  deploymentId    String
  deployment      Deployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  stepName        String   // 'pull_image', 'create_container', etc.
  status          String   // 'pending', 'running', 'completed', 'failed'
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  duration        Int?     // Milliseconds
  output          String?  // Step output/logs
  errorMessage    String?
  
  @@index([deploymentId])
  @@map("deployment_steps")
}
```

### 2.6 New System Dependencies

- **Traefik Configuration**: Requires Traefik to be configured with Docker provider
- **Docker Networks**: Shared network between Traefik and application containers
- **Container Labels**: Support for Docker label-based configuration
- **DNS Configuration**: Proper DNS setup for application domains

### 2.7 Scalability and Performance

#### Performance Optimizations
- **Image Caching**: Local Docker image cache to reduce pull times
- **Parallel Health Checks**: Concurrent health check execution
- **Connection Pooling**: Reuse HTTP connections for health checks
- **Async Operations**: Non-blocking deployment execution
- **Progress Streaming**: Server-sent events for real-time updates

#### Scalability Considerations
- **Single Host Limitation**: Current design for single Docker host
- **Deployment Queue**: Sequential deployments per application
- **Resource Limits**: Container resource constraints to prevent host overload
- **Monitoring**: Prometheus metrics for deployment performance

### 2.8 Security Considerations

#### Authentication & Authorization
- **API Key Validation**: Webhook endpoints require valid API key
- **User Permissions**: Deployments linked to user accounts
- **Audit Trail**: Complete logging of deployment actions

#### Container Security
- **Image Verification**: Optional image signature validation
- **Registry Authentication**: Secure credential storage for private registries
- **Network Isolation**: Containers in isolated networks
- **Secret Management**: Environment variables encrypted in database

#### Configuration Security
- **Encrypted Storage**: Sensitive configuration encrypted using `crypto-js`
- **Access Control**: User-scoped deployment configurations
- **Input Validation**: Zod schemas for all configuration inputs

### 2.9 Testing Strategy

#### Unit Tests
- **State Machine Tests**: Validate all state transitions
- **Health Check Logic**: Mock HTTP responses for various scenarios
- **Configuration Validation**: Schema validation edge cases
- **Rollback Logic**: Failure recovery scenarios

#### Integration Tests
- **Docker Mock**: Test container lifecycle with mock Docker API
- **Traefik Integration**: Label generation and updates
- **Database Operations**: Deployment history and state persistence
- **API Endpoints**: Webhook authentication and validation

#### End-to-End Tests
- **Deployment Simulation**: Full deployment cycle with test containers
- **Failure Scenarios**: Network failures, timeout handling
- **Concurrent Deployments**: Queue management and isolation

### 2.10 Deployment and Maintenance

#### Self-Deployment Capability
- **Bootstrap Mode**: Deploy Mini Infra using Mini Infra
- **Blue-Green for Self**: Zero-downtime updates of the platform

#### Monitoring & Alerting
- **Deployment Metrics**: Success rate, duration, failure reasons
- **Health Check History**: Track application health over time
- **Resource Usage**: Container CPU/memory monitoring
- **Alert Integration**: Webhook notifications for failures

#### Maintenance Operations
- **Cleanup Jobs**: Remove old containers and images
- **Log Rotation**: Deployment log management
- **Database Pruning**: Archive old deployment records
- **Cache Management**: Clear stale deployment states

### 2.11 System Integration

#### Integration Points
- **Docker Service**: Extend existing `DockerService` class
- **Progress Tracker**: Use existing progress tracking system
- **Logging System**: Integrate with domain-specific loggers
- **Authentication**: Leverage existing JWT and API key middleware

#### API Design
```typescript
// Deployment trigger endpoint
POST /api/deployments/trigger
Headers: Authorization: Bearer mk_xxx
Body: {
  applicationName: string
  tag?: string  // Optional, uses configured default
  force?: boolean  // Skip health checks
}

// Deployment status
GET /api/deployments/:id/status
Response: {
  status: string
  progress: number
  steps: DeploymentStep[]
  logs: string[]
}

// Rollback endpoint
POST /api/deployments/:id/rollback
```

#### Frontend Integration
- **Deployment Dashboard**: Real-time deployment status
- **Configuration Form**: Validated deployment settings
- **History View**: Past deployments with metrics
- **Log Viewer**: Streaming deployment logs

## 3. Technical Design and Architecture Summary

The Zero Downtime Deployment System will be implemented as a comprehensive extension to Mini Infra's existing architecture, leveraging the established patterns for configuration management, service integration, and authentication.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend (React)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │ Config Forms │  │ Deploy Button│  │ Status Monitor  │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTPS/JWT
┌────────────────────────────▼─────────────────────────────────┐
│                    API Layer (Express)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │ Webhook API  │  │ Deployment   │  │ Configuration   │   │
│  │   /deploy    │  │   Routes     │  │     Routes      │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                    Service Layer                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │           Deployment Orchestrator (XState)              │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │ │
│  │  │  State   │  │  Event   │  │  Progress        │    │ │
│  │  │  Machine │──│  Store   │──│  Tracker         │    │ │
│  │  └──────────┘  └──────────┘  └──────────────────┘    │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │Health Check  │  │ Container    │  │ Traefik         │   │
│  │  Service     │  │ Lifecycle    │  │ Integration     │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                 Infrastructure Layer                          │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │Docker Engine │  │   Traefik    │  │  SQLite (Prisma)│   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```
