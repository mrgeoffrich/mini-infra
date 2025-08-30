# Cloudflare Settings and Connectivity - Technical Design and Architecture

## 1. Feature Breakdown

### 1.1 Core Components
- **Cloudflare Settings Management**: API token and account ID configuration with secure storage
- **Connectivity Monitoring**: Real-time and scheduled health checks of Cloudflare API connectivity
- **Tunnel Information Retrieval**: Read-only access to Cloudflare tunnel information and status
- **Settings UI**: React-based configuration interface with real-time validation
- **API Endpoints**: RESTful endpoints for CRUD operations and connectivity testing
- **Background Scheduler Integration**: Periodic connectivity checks with circuit breaker pattern

### 1.2 Functional Requirements
- Store and validate Cloudflare API tokens securely
- Test API connectivity with timeout protection
- Retrieve and display tunnel information
- Monitor connectivity status with historical tracking
- Provide real-time validation feedback in UI
- Support manual and automated connectivity testing
- Handle rate limiting and API errors gracefully

## 2. Implementation Considerations

### 2.1 Software Design

#### Backend Architecture
```
server/
├── routes/
│   ├── cloudflare-settings.ts     # Cloudflare-specific settings endpoints
│   └── cloudflare-connectivity.ts # Connectivity status retrieval
├── services/
│   └── cloudflare-config.ts       # Already exists - Cloudflare configuration service
├── lib/
│   └── connectivity-scheduler.ts  # Background monitoring integration
└── generated/
    └── prisma/                     # Database models
```

#### Frontend Architecture  
```
client/
├── hooks/
│   └── use-cloudflare-settings.ts # React Query hooks for Cloudflare management
├── app/
│   └── settings/
│       └── cloudflare/
│           └── page.tsx            # Already exists - needs key mapping fixes
└── components/
    └── cloudflare/
        └── tunnel-status.tsx       # Tunnel information display component
```

#### Data Flow Architecture
1. **Settings Configuration Flow**:
   - User inputs API token → Frontend validation → API request with encryption flag
   - Backend stores in SystemSettings table with encryption
   - Immediate validation triggered → Results stored in ConnectivityStatus table
   - UI updates with validation results

2. **Connectivity Testing Flow**:
   - Manual test request → CloudflareConfigService.validate()
   - API call with timeout protection (10s)
   - Response parsing for user info and account details
   - Status recording in ConnectivityStatus table
   - Real-time UI update via React Query

3. **Tunnel Information Flow**:
   - Request for tunnel data → Check API token availability
   - Cloudflare API call for tunnel list
   - Transform and filter tunnel data
   - Return structured tunnel information
   - Cache results with TTL for performance

### 2.2 Software Libraries

#### Existing Dependencies (Already Installed)
- **cloudflare**: ^4.5.0 - Official Cloudflare SDK for API interactions
- **@types/cloudflare**: ^2.7.15 - TypeScript definitions
- **zod**: ^4.1.4 - Runtime validation for API requests/responses
- **prisma**: ^6.15.0 - Database ORM
- **pino**: ^9.9.0 - Structured logging
- **react-query**: For frontend state management
- **react-hook-form**: Form handling with validation

#### No Additional Libraries Required
The existing dependency set fully supports all required functionality.

### 2.3 External Dependencies

#### Cloudflare API Integration
- **API Endpoints Used**:
  - `GET /user` - Validate token and retrieve user information
  - `GET /accounts/{account_id}` - Validate account access
  - `GET /accounts/{account_id}/cfd_tunnel` - List tunnels
  - `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}` - Tunnel details

- **Rate Limits**:
  - 1200 requests per 5 minutes (default tier)
  - Implement exponential backoff for rate limit errors
  - Cache validation results for 5 minutes minimum

- **Error Handling**:
  - 401: Invalid or expired API token
  - 403: Insufficient permissions
  - 429: Rate limit exceeded
  - 500-503: Cloudflare service errors

### 2.4 Important Flows

#### Authentication Flow
1. Frontend sends API token with encryption flag
2. Backend validates format (minimum 40 characters)
3. Token stored encrypted in SystemSettings
4. Immediate validation against Cloudflare API
5. Results stored with user metadata
6. Frontend receives validation status

#### Validation Flow with Circuit Breaker
```typescript
1. Check circuit breaker status
2. If open (too many failures):
   - Return cached status
   - Skip API call
3. If closed:
   - Attempt API validation
   - On success: Reset failure count
   - On failure: Increment failure count
   - Open circuit if threshold reached
4. Record connectivity status
5. Update validation timestamp
```

#### Tunnel Monitoring Flow
1. Verify API token and account ID configured
2. Query Cloudflare API for tunnel list
3. For each tunnel:
   - Extract ID, name, status, connections
   - Check connection health
   - Format for frontend display
4. Return aggregated tunnel status
5. Cache results for 60 seconds

### 2.5 Database Changes

No schema changes required. Existing tables support all functionality:

#### SystemSettings Table Usage
- **Category**: 'cloudflare'
- **Keys**:
  - `api_token`: Encrypted API token storage
  - `account_id`: Plain text account identifier
- **Validation Fields**: Track last validation time and status

#### ConnectivityStatus Table Usage
- **Service**: 'cloudflare'
- **Status Values**: 'connected', 'failed', 'timeout', 'unreachable'
- **Metadata**: Store user email, account name, tunnel count
- **Historical Tracking**: Maintain last 100 records per service

### 2.6 New System Dependencies

No new system dependencies required. The application runs entirely within the Node.js runtime using the existing Docker container setup.

### 2.7 Scalability and Performance

#### Caching Strategy
- **API Token Validation**: Cache for 5 minutes after successful validation
- **Tunnel Information**: Cache for 60 seconds with refresh on demand
- **Account Information**: Cache for 15 minutes
- **Connectivity Status**: Store last 100 checks, prune older records

#### Performance Optimizations
- **Connection Pooling**: Reuse HTTPS connections to Cloudflare API
- **Request Deduplication**: Prevent duplicate validation requests within 1 second
- **Batch Operations**: Combine multiple setting updates in single transaction
- **Lazy Loading**: Load tunnel details only when expanded in UI

#### Resource Limits
- **Timeout Protection**: 10-second timeout on all Cloudflare API calls
- **Memory Management**: Limit cached data to 10MB per service
- **Database Queries**: Index on service and checkedAt for fast retrieval
- **Concurrent Requests**: Maximum 3 parallel Cloudflare API calls

### 2.8 Security Considerations

#### Data Protection
- **API Token Encryption**: AES-256 encryption at rest
- **No Token Logging**: Redact tokens from all log output
- **Secure Transmission**: HTTPS only for API communication
- **Token Scope Validation**: Verify minimum required permissions

#### Access Control
- **Authentication Required**: All endpoints require authenticated user
- **Audit Logging**: Track who creates/updates/deletes settings
- **Rate Limiting**: Implement per-user rate limits for API calls
- **Input Validation**: Strict validation of all user inputs

#### Security Headers
```typescript
{
  'Content-Security-Policy': "default-src 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
}
```

### 2.9 Testing Strategy

#### Unit Testing
- **Service Layer**: Mock Cloudflare API responses
- **Validation Logic**: Test all error scenarios
- **Encryption**: Verify token encryption/decryption
- **Rate Limiting**: Test circuit breaker behavior

#### Integration Testing
- **API Endpoints**: Test full request/response cycle
- **Database Operations**: Verify CRUD operations
- **Authentication**: Test auth middleware
- **Error Handling**: Verify error responses

#### End-to-End Testing
- **Settings Flow**: Complete configuration and validation
- **Connectivity Monitoring**: Background scheduler integration
- **UI Validation**: Real-time form validation
- **Error Recovery**: Test failure scenarios

#### Test Data Management
```typescript
// Use CUID2 for unique test identifiers
const testUserId = createId();
const testApiToken = 'test_' + randomBytes(40).toString('hex');
const testAccountId = randomBytes(16).toString('hex');

// Mock Cloudflare responses
const mockUserResponse = {
  id: 'user_123',
  email: 'test@example.com',
  suspended: false
};

const mockTunnelResponse = {
  result: [{
    id: 'tunnel_123',
    name: 'test-tunnel',
    status: 'healthy',
    connections: []
  }]
};
```

### 2.10 Deployment and Maintenance

#### Deployment Requirements
- **Environment Variables**: No new variables required
- **Database Migrations**: No schema changes needed
- **Feature Flags**: Optional gradual rollout support
- **Rollback Plan**: Settings remain functional with previous version

#### Monitoring and Alerting
- **Metrics to Track**:
  - API validation success rate
  - Average response time
  - Circuit breaker state changes
  - Token validation failures

- **Alert Thresholds**:
  - Validation failure rate > 50% for 5 minutes
  - API response time > 5 seconds
  - Circuit breaker open for > 10 minutes
  - Database connection failures

#### Maintenance Tasks
- **Daily**: Review connectivity logs for anomalies
- **Weekly**: Check API rate limit usage
- **Monthly**: Prune old connectivity records
- **Quarterly**: Review and rotate API tokens

### 2.11 System Integration

#### Integration with Existing Services
- **Settings Service**: Extends base ConfigurationService class
- **Connectivity Scheduler**: Registers Cloudflare service for monitoring
- **Authentication System**: Uses existing auth middleware
- **Logging System**: Integrates with Pino structured logging

#### API Contract
```typescript
// Cloudflare Settings Endpoints
POST   /api/settings/cloudflare       - Create/update configuration
GET    /api/settings/cloudflare       - Retrieve current configuration
DELETE /api/settings/cloudflare       - Remove configuration
POST   /api/settings/cloudflare/test  - Test connectivity

// Cloudflare Connectivity Endpoints
GET    /api/connectivity/cloudflare        - Get latest status
GET    /api/connectivity/cloudflare/history - Get historical data

// Cloudflare Tunnel Endpoints
GET    /api/cloudflare/tunnels        - List all tunnels
GET    /api/cloudflare/tunnels/:id    - Get tunnel details
```

#### Frontend Integration
```typescript
// React Query Hooks
useCloudflareSettings()     // Get current settings
useUpdateCloudflareSettings() // Update settings
useTestCloudflareConnection() // Manual connectivity test
useCloudflareConnectivity()   // Get connectivity status
useCloudfareTunnels()         // List tunnels
```

### 2.12 Risk Assessment and Mitigation

#### Identified Risks

1. **API Token Exposure**
   - **Risk**: Token leaked through logs or error messages
   - **Mitigation**: Automatic redaction, encrypted storage
   - **Severity**: High
   - **Likelihood**: Low with proper implementation

2. **Rate Limiting**
   - **Risk**: Hitting Cloudflare API rate limits
   - **Mitigation**: Request caching, circuit breaker pattern
   - **Severity**: Medium
   - **Likelihood**: Medium during initial setup

3. **Service Unavailability**
   - **Risk**: Cloudflare API downtime affects functionality
   - **Mitigation**: Graceful degradation, cached data usage
   - **Severity**: Low
   - **Likelihood**: Low

4. **Invalid Permissions**
   - **Risk**: API token lacks required permissions
   - **Mitigation**: Permission validation on setup
   - **Severity**: Low
   - **Likelihood**: Medium

#### Contingency Plans
- **Fallback Mode**: Use cached data when API unavailable
- **Manual Override**: Allow disabling automatic checks
- **Emergency Shutdown**: Quick disable via environment variable
- **Data Recovery**: Settings backup in database

## 3. Technical Design and Architecture Summary

The Cloudflare settings and connectivity feature leverages the existing infrastructure while adding specialized endpoints and services for Cloudflare-specific functionality. The design prioritizes security through encryption and access control, reliability through circuit breakers and caching, and user experience through real-time validation and clear error messaging.

Key architectural decisions:
- **Dedicated API Routes**: Separate Cloudflare endpoints for better organization and maintenance
- **Service Layer Reuse**: Extends existing ConfigurationService for consistency
- **React Query Integration**: Provides real-time updates and optimistic UI updates
- **Background Monitoring**: Integrates with existing scheduler for automated health checks
- **Security First**: Encrypted storage, input validation, and comprehensive error handling

The implementation requires minimal new code as it builds upon the established patterns from the Azure integration, ensuring consistency across the codebase while providing Cloudflare-specific optimizations and error handling.

### Implementation Priority
1. **Phase 1**: Fix frontend key mapping issues (api_token vs apiToken)
2. **Phase 2**: Create dedicated Cloudflare API routes
3. **Phase 3**: Implement frontend hooks and improve UI
4. **Phase 4**: Add tunnel information display
5. **Phase 5**: Integrate with background scheduler

### Success Metrics
- Configuration save success rate > 99%
- API validation response time < 2 seconds
- Zero token exposure incidents
- UI feedback response time < 100ms
- Background check reliability > 99.9%