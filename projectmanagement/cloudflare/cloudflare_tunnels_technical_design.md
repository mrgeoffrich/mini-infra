# Cloudflare Tunnels - Technical Design and Architecture

## 1. Feature Breakdown

The Cloudflare Tunnels feature provides monitoring and configuration management of existing Cloudflare tunnels for the Mini Infra application, including the ability to manage public hostnames and their routing configuration. The feature consists of the following core components:

- **Cloudflare API Integration Service**: Handles communication with Cloudflare API for tunnel data retrieval and configuration management
- **Tunnel Data Management**: Caches and manages tunnel information with periodic updates
- **Hostname Configuration Management**: Create, update, and delete public hostname routes for tunnels
- **Backend API Endpoints**: RESTful endpoints for tunnel operations and configuration with authentication
- **Frontend Dashboard**: React-based UI for tunnel monitoring, visualization, and configuration
- **Database Schema**: Models for tunnel configuration, hostname routing, and activity logging
- **Security Layer**: API token management and secure storage

## 2. Implementation Considerations

### 2.1 Software Design

**Cloudflare SDK Integration Service (`server/src/services/cloudflare.ts`)**
- Singleton service pattern similar to existing DockerService
- Uses official Cloudflare TypeScript SDK for API communication
- Built-in retry logic and error handling from SDK
- Automatic rate limiting compliance
- Type-safe API interactions with full TypeScript definitions
- Data transformation from SDK responses to internal models

**Tunnel Cache Management**
- In-memory cache using NodeCache (similar to Docker service)
- 190-second TTL for tunnel data to balance performance and freshness
- Database persistence for tunnel configurations and metadata
- Event-driven cache invalidation

**Backend API Controller (`server/src/routes/tunnels.ts`)**
- RESTful endpoints following existing pattern:
  - `GET /api/tunnels` - List all tunnels with filtering
  - `GET /api/tunnels/:id` - Get specific tunnel details
  - `GET /api/tunnels/:id/status` - Get tunnel health status
  - `GET /api/tunnels/:id/routes` - Get public hostname routes for tunnel
  - `POST /api/tunnels/:id/routes` - Create new public hostname route
  - `PUT /api/tunnels/:id/routes/:routeId` - Update existing hostname route
  - `DELETE /api/tunnels/:id/routes/:routeId` - Delete hostname route
- Authentication middleware integration
- Request correlation ID support
- Input validation with Zod schemas for configuration data

**Frontend Dashboard (`client/src/app/tunnels/`)**
- React component structure following container dashboard pattern
- Custom hooks for data fetching and configuration management
- Periodic polling with React Query (30-second intervals, suitable for infrequent changes)
- Responsive table layout with filtering and sorting
- Configuration forms for hostname management with validation
- Modal dialogs for creating/editing public hostname routes

### 2.2 Software Libraries

**New Backend Dependencies:**
```json
{
  "dependencies": {
    "cloudflare": "^4.5.0"
  }
}
```

**Frontend Dependencies (already available):**
- React Query for data fetching and caching
- @tanstack/react-table for tunnel data display
- date-fns for timestamp formatting
- Existing UI components from shadcn

**Cloudflare SDK Usage Example:**
```typescript
// server/src/services/cloudflare.ts
import Cloudflare from 'cloudflare';

class CloudflareService {
  private static instance: CloudflareService;
  private client: Cloudflare;
  
  private constructor() {
    this.client = new Cloudflare({
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
    });
  }
  
  async getTunnels(accountId: string) {
    try {
      // SDK automatically handles pagination, retries, and rate limiting
      const tunnels = await this.client.zeroTrust.tunnels.list({
        account_id: accountId,
      });
      return tunnels;
    } catch (error) {
      // SDK provides typed error responses
      logger.error('Failed to fetch tunnels', { error });
      throw error;
    }
  }
  
  async createTunnelRoute(accountId: string, tunnelId: string, hostname: string, service: string) {
    try {
      const route = await this.client.zeroTrust.tunnels.configurations.update(tunnelId, {
        account_id: accountId,
        config: {
          ingress: [
            {
              hostname: hostname,
              service: service
            }
          ]
        }
      });
      return route;
    } catch (error) {
      logger.error('Failed to create tunnel route', { error, tunnelId, hostname });
      throw error;
    }
  }
}
```

### 2.3 External Dependencies

**Cloudflare SDK Integration:**
- Official Cloudflare TypeScript SDK (cloudflare npm package)
- Required API permissions: Zone:Read, Zone:Edit, Tunnel:Read, Tunnel:Edit
- API token authentication with secure storage
- Built-in rate limiting and error handling
- Automatic pagination and data fetching
- TypeScript definitions for all request/response types

**Network Requirements:**
- HTTPS outbound connections to `api.cloudflare.com`
- DNS resolution for Cloudflare API endpoints
- Firewall rules allowing outbound API calls

### 2.4 Important Flows

**Tunnel Data Fetch Flow:**
1. Frontend requests tunnels via `/api/tunnels`
2. Backend checks cache validity (5-minute TTL)
3. If cache miss or expired:
   - CloudflareService uses SDK to fetch tunnel data
   - SDK automatically handles pagination and retries
   - Transform SDK response to internal format
   - Update cache and database
   - Return processed data
4. Frontend receives tunnel data and updates UI

**Periodic Status Updates:**
1. React Query polls `/api/tunnels` every 30 seconds (suitable for infrequent changes)
2. Backend service caches tunnel data with longer TTL for configuration stability
3. Cache invalidation occurs after configuration changes
4. Frontend receives updates and refreshes display
5. Visual indicators update tunnel health status

**Configuration Management Flow:**
1. User initiates hostname route creation/modification via UI form
2. Frontend validates input and sends request to `/api/tunnels/:id/routes`
3. Backend validates configuration and applies changes via Cloudflare SDK
4. SDK handles API communication with built-in error handling
5. Success/failure response returned with typed error information
6. Cache invalidation triggers fresh data fetch to reflect changes
7. Activity logging records all configuration changes for audit trail

**Authentication Flow for API Access:**
1. User configures Cloudflare API token in settings
2. Token encrypted and stored in database
3. Service validates token on first use
4. Token included in all Cloudflare API requests
5. Error handling for expired/invalid tokens

### 2.5 Database Changes

**New Prisma Models:**

```prisma
// Cloudflare tunnel configuration and metadata
model CloudflareTunnel {
  id                String    @id @default(cuid())
  tunnelId          String    @unique  // Cloudflare tunnel UUID
  name              String
  accountId         String
  status            String    // active, down, degraded
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  lastStatusCheck   DateTime?
  
  // Cached tunnel data
  connections       Json?     // Active connections
  configuration     Json?     // Tunnel configuration
  
  // Relations
  routes            TunnelRoute[]
  
  @@map("cloudflare_tunnels")
}

// Public hostname routes for tunnels
model TunnelRoute {
  id          String   @id @default(cuid())
  tunnelId    String   // References CloudflareTunnel
  routeId     String   // Cloudflare route UUID
  hostname    String   // Public hostname (e.g., api.example.com)
  service     String   // Target service URL (e.g., http://localhost:3000)
  path        String?  // Optional path matching
  type        String   @default("http")  // Route type: http, https, tcp
  enabled     Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  // Relations
  tunnel      CloudflareTunnel @relation(fields: [tunnelId], references: [id], onDelete: Cascade)
  
  @@index([tunnelId])
  @@index([hostname])
  @@map("tunnel_routes")
}

// Cloudflare API configuration
model CloudflareConfig {
  id          String   @id @default(cuid())
  userId      String   @unique
  apiToken    String   // Encrypted API token
  accountId   String?  // Optional account ID filter
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  // Relations
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@map("cloudflare_config")
}

// Activity logging for tunnel operations
model TunnelActivity {
  id          String   @id @default(cuid())
  userId      String?
  tunnelId    String?
  routeId     String?  // For route-specific activities
  action      String   // status_check, route_created, route_updated, route_deleted, configuration_update, error
  status      String   // success, failure, warning
  message     String?
  metadata    Json?    // Store previous/new values for configuration changes
  createdAt   DateTime @default(now())
  
  @@index([createdAt])
  @@index([tunnelId])
  @@index([routeId])
  @@map("tunnel_activities")
}
```

**User Model Updates:**
```prisma
model User {
  // ... existing fields
  
  // New relations
  cloudflareConfig CloudflareConfig?
}
```

### 2.6 New System Dependencies

**Environment Variables:**
```bash
# Cloudflare Configuration
CLOUDFLARE_API_BASE_URL=https://api.cloudflare.com/client/v4
CLOUDFLARE_RATE_LIMIT_PER_MINUTE=240
CLOUDFLARE_REQUEST_TIMEOUT=10000

# Cache Configuration
TUNNEL_CACHE_TTL=300000  # 5 minutes - longer cache for configuration stability
TUNNEL_POLL_INTERVAL=30000  # 30 seconds - slower polling for infrequent changes
```

**Docker Configuration (if applicable):**
- No additional Docker dependencies
- Existing Docker host can run Cloudflare tunnel containers
- Optional: Cloudflare tunnel container discovery

### 2.7 Scalability and Performance

**Caching Strategy:**
- In-memory cache with 5-minute TTL (suitable for infrequent configuration changes)
- Database persistence for tunnel metadata and route configurations
- Cache invalidation after configuration changes
- Conditional requests using ETags when supported
- Batch API calls for multiple tunnel status checks

**Rate Limiting:**
- Implement exponential backoff for API failures
- Respect Cloudflare API rate limits (1,200 requests/5min)
- Circuit breaker pattern for API availability
- Queue API requests during high load

**Performance Optimizations:**
- Lazy loading of tunnel details
- Pagination for large tunnel lists
- Debounced search and filtering
- Connection pooling for API requests

### 2.8 Security Considerations

**API Token Security:**
- Encrypt API tokens using existing encryption utilities
- Store tokens securely in database
- Rotate tokens periodically (user-initiated)
- Mask tokens in logs and error messages
- Validate token permissions on configuration

**Data Protection:**
- Sanitize tunnel configuration data
- Redact sensitive information in logs
- Implement input validation for all API endpoints
- Use HTTPS for all Cloudflare API communications

**Access Control:**
- Integrate with existing authentication system
- User-scoped tunnel configurations
- API key support for programmatic access
- Role-based access (future consideration)

### 2.9 Testing Strategy

**Unit Tests:**
```typescript
// CloudflareService tests
describe('CloudflareService', () => {
  test('should fetch tunnels from API')
  test('should handle API rate limiting')
  test('should cache tunnel data correctly')
  test('should handle authentication errors')
  test('should create hostname routes')
  test('should update hostname routes')
  test('should delete hostname routes')
  test('should validate route configurations')
})

// API endpoint tests
describe('Tunnels API', () => {
  test('GET /api/tunnels - should return paginated tunnels')
  test('GET /api/tunnels/:id - should return tunnel details')
  test('GET /api/tunnels/:id/routes - should return tunnel routes')
  test('POST /api/tunnels/:id/routes - should create new route')
  test('PUT /api/tunnels/:id/routes/:routeId - should update route')
  test('DELETE /api/tunnels/:id/routes/:routeId - should delete route')
  test('should handle authentication requirements')
  test('should validate route configuration data')
})
```

**Integration Tests:**
- Mock Cloudflare API responses
- Test cache invalidation scenarios
- Validate data transformation accuracy
- Test error handling for API failures

**Frontend Tests:**
- Component rendering with mock data
- User interaction testing (filtering, sorting)
- Configuration form validation and submission
- Route creation/editing modal interactions
- Error state handling for configuration operations
- Success state handling and cache updates

### 2.10 Deployment and Maintenance

**Database Migration:**
```bash
# Apply new schema changes
npx prisma db push

# Generate new Prisma client
npx prisma generate
```

**Configuration Steps:**
1. Add environment variables to `.env`
2. Configure Cloudflare API token in application settings
3. Verify API connectivity and permissions
4. Enable tunnel monitoring in dashboard

**Monitoring and Alerting:**
- Log API request failures and rate limiting
- Monitor cache hit rates and performance
- Track tunnel status changes
- Alert on API token expiration

**Maintenance Tasks:**
- Regular cache cleanup (automated)
- API token rotation (user-initiated)
- Performance monitoring and optimization
- Cloudflare API version updates

### 2.11 System Integration

**Integration with Existing Components:**

**Authentication System:**
- Extend existing User model with Cloudflare configuration
- Use existing session management for API access
- Integrate with API key authentication system

**Logging System:**
- Use existing Pino logging infrastructure
- Add tunnel-specific log events and correlation IDs
- Integrate with request tracing system

**UI System:**
- Follow existing design patterns from container dashboard
- Use shared UI components and styling
- Integrate with navigation and routing system

**Database System:**
- Extend existing Prisma schema
- Use existing migration and client generation processes
- Integrate with existing backup and maintenance procedures

### 2.12 Risk Assessment and Mitigation

**Technical Risks:**

**Risk: Cloudflare API Rate Limiting**
- *Mitigation*: Implement intelligent caching and request batching
- *Fallback*: Display cached data when API is rate limited
- *Monitoring*: Track API usage and implement alerts

**Risk: API Token Expiration/Revocation**
- *Mitigation*: Graceful error handling and user notification
- *Fallback*: Disable tunnel monitoring until token is updated
- *Monitoring*: Regular token validation checks

**Risk: Network Connectivity Issues**
- *Mitigation*: Implement retry logic with exponential backoff
- *Fallback*: Display last known status with timestamp
- *Monitoring*: Track API response times and failures

**Risk: Large Number of Tunnels Performance**
- *Mitigation*: Implement pagination and lazy loading
- *Fallback*: Limit initial load to most critical tunnels
- *Monitoring*: Performance metrics for large datasets

**Operational Risks:**

**Risk: Configuration Complexity**
- *Mitigation*: Provide clear setup documentation and validation
- *Recovery*: Configuration reset and troubleshooting tools
- *Prevention*: Input validation and helpful error messages

**Risk: Data Inconsistency**
- *Mitigation*: Implement data validation and reconciliation
- *Recovery*: Manual refresh and cache clearing options
- *Prevention*: Consistent data transformation and caching

## 3. Technical Design and Architecture Summary

The Cloudflare Tunnels feature extends Mini Infra with comprehensive tunnel monitoring and configuration management capabilities while maintaining consistency with existing architectural patterns. The design emphasizes security, performance, and reliability through:

**Core Architecture:**
- Service-oriented design with singleton pattern for external API management
- Multi-layer caching strategy balancing performance and data freshness
- RESTful API endpoints with comprehensive authentication and validation
- React-based frontend following established UI patterns

**Key Strengths:**
- Seamless integration with existing authentication and logging systems
- Robust error handling and graceful degradation capabilities
- Scalable design supporting growth in tunnel count and user base
- Security-first approach with encrypted token storage and data protection
- Configuration management with full audit trail and rollback capabilities
- Optimized for infrequent changes with appropriate caching and polling intervals

**Implementation Priority:**
1. Backend service and API integration (Core functionality)
2. Database schema and caching implementation (Data layer)
3. Hostname route configuration API endpoints (Configuration management)
4. Frontend dashboard and monitoring interface (User experience)
5. Frontend configuration forms and modals (Configuration UI)
6. Advanced features and optimizations (Enhancement phase)

The architecture provides a solid foundation for tunnel monitoring and basic configuration management while maintaining the ability to extend functionality in future iterations, such as advanced routing rules, SSL certificate management, or detailed analytics capabilities.