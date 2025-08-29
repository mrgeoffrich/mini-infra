# Settings and Configuration Management - Technical Design and Architecture

## 1. Feature Breakdown

### 1.1 Core Components
- **System Settings Management**: Docker host configuration, Cloudflare API credentials, Azure Storage integration
- **System Preferences Management**: Core application configuration preferences
- **Settings Validation Services**: Real-time validation of external service connectivity and configuration correctness  
- **Settings Audit System**: Activity logging for configuration changes

### 1.2 Functional Requirements
- Store and validate Cloudflare API keys with connectivity testing
- Configure and verify Docker host connection parameters
- Manage Azure Storage Account credentials for backup operations

## 2. Implementation Considerations

### 2.1 Software Design

#### Database Schema Design
**SystemSettings Model**:
```typescript
model SystemSettings {
  id                    String   @id @default(cuid())
  category              String   // 'docker', 'cloudflare', 'azure'
  key                   String   // Specific setting key within category
  value                 String   // Encrypted value for sensitive data
  isEncrypted           Boolean  @default(false)
  isActive              Boolean  @default(true)
  lastValidatedAt       DateTime?
  validationStatus      String?  // 'valid', 'invalid', 'pending', 'error'
  validationMessage     String?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  createdBy            String   // User ID who created the setting
  updatedBy            String   // User ID who last updated the setting
  
  @@unique([category, key])
  @@map("system_settings")
}
```

**SettingsAudit Model**:
```typescript
model SettingsAudit {
  id          String   @id @default(cuid())
  category    String   // Setting category that was changed
  key         String   // Setting key that was changed
  action      String   // 'create', 'update', 'delete', 'validate'
  oldValue    String?  // Previous value (never store sensitive data)
  newValue    String?  // New value (never store sensitive data)
  userId      String   // User who made the change
  ipAddress   String?  // Source IP address
  userAgent   String?  // User agent string
  success     Boolean  @default(true)
  errorMessage String? // Error details if action failed
  createdAt   DateTime @default(now())
  
  @@map("settings_audit")
}
```

**ConnectivityStatus Model**:
```typescript
model ConnectivityStatus {
  id                    String   @id @default(cuid())
  service               String   // 'cloudflare', 'docker', 'azure'
  status                String   // 'connected', 'failed', 'timeout', 'unreachable'
  responseTimeMs        Int?     // Response time in milliseconds for successful connections
  errorMessage          String?  // Detailed error message for failed connections
  errorCode             String?  // Service-specific error code
  lastSuccessfulAt      DateTime? // Last successful connection timestamp
  checkedAt             DateTime @default(now()) // When this check was performed
  checkInitiatedBy      String?  // User ID who initiated manual check (null for scheduled checks)
  
  // Service-specific metadata (JSON stored as string)
  metadata              String?  // Additional service-specific information
  
  @@index([service])
  @@index([status])
  @@index([checkedAt])
  @@index([service, checkedAt])
  @@map("connectivity_status")
}
```

#### Service Architecture Pattern
```typescript
// Abstract base class for all configuration services
abstract class ConfigurationService {
  abstract validate(): Promise<ValidationResult>
  abstract getHealthStatus(): Promise<HealthStatus>
  protected abstract set(value: string): string
  protected abstract get(value: string): string
}

// Specific implementations
class DockerConfigService extends ConfigurationService
class CloudflareConfigService extends ConfigurationService  
class AzureConfigService extends ConfigurationService
```

#### API Layer Design
- **RESTful endpoints**: `/api/settings/system/:category`, `/api/settings/validate/:category`
- **Validation endpoints**: Real-time validation with debounced requests
- **Audit endpoints**: Settings change history

### 2.2 Software Libraries

#### Backend Dependencies
```json
{
  "@azure/storage-blob": "^12.17.0", // Azure Storage SDK for validation
  "cloudflare": "^3.3.0",          // Cloudflare API client
  "dockerode": "^4.0.7",           // Already included - Docker API
  "ajv": "^8.12.0",                // JSON schema validation
}
```

#### Frontend Dependencies  
```json
{
  "@hookform/resolvers": "^3.3.2",   // React Hook Form integration
  "react-hook-form": "^7.47.0",     // Already in use - form management
  "zod": "^4.1.4",                  // Already in use - schema validation
  "react-query": "^3.39.3",         // Already in use - state management
  "react-json-view": "^1.21.3"      // JSON editor for advanced settings
}
```

### 2.3 External Dependencies

#### Required External Services
- **Cloudflare API**: Token-based authentication for tunnel management validation
- **Docker Engine API**: Socket or TCP connection for container management validation  
- **Azure Storage Account**: Connection string validation and container access testing

### 2.4 Important Flows

#### Settings Validation Flow
```
1. User submits setting change via React form
2. Frontend validates using Zod schema
3. API endpoint receives validated data
4. Configuration service validates external connectivity
5. Database updated with validation status
6. Audit log entry created
7. Connectivity success feedback sent to frontend and stored in the database
```

#### Settings Retrieval Flow
```
1. Frontend requests settings on page load
2. System settings and preferences retrieved
```

### 2.6 New System Dependencies

#### Background Processing
- **Validation Scheduler**: Periodic health checks for external services every 5 minutes
- **Retry Mechanism**: Exponential backoff for failed validations
- **Circuit Breaker**: Prevent cascading failures from external API issues
- **Update Database**: Update the database if theres a connectivity issue

### 2.7 Scalability and Performance

#### Caching Strategy
- **Settings Cache**: In-memory cache with 5-minute TTL for system settings
- **System Preferences Cache**: Application-wide caching for core system preferences
- **Validation Results Cache**: 15-minute TTL for external service validation results
- **Cache Warming**: Preload critical settings on application startup

### 2.8 Security Considerations

#### Access Control  
- **API Authentication**: All endpoints protected by session or API key authentication
- **CSRF Protection**: Cross-site request forgery tokens for state-changing operations

#### Audit and Compliance
- **Complete Audit Trail**: All configuration changes logged with user context
- **Immutable Logs**: Audit entries cannot be modified or deleted
- **Data Retention**: Configurable retention period for audit logs
- **Export Capabilities**: Audit log export for compliance reporting

### 2.9 Testing Strategy

#### Unit Testing
```typescript
// Service layer testing with mocked external APIs
describe('CloudflareConfigService', () => {
  it('should validate API key successfully', async () => {
    // Mock Cloudflare API response
    // Test service validation logic
    // Verify encryption/decryption
  })
})

// Database model testing
describe('SystemSettings Model', () => {
  it('should encrypt sensitive values on create', async () => {
    // Test automatic encryption
    // Verify data integrity
  })
})
```

#### Integration Testing
```typescript
// API endpoint testing with test database
describe('Settings API', () => {
  it('should update system setting with audit log', async () => {
    // Test complete flow from API to database
    // Verify audit log creation
    // Check authorization enforcement
  })
})
```

#### End-to-End Testing
```typescript
// Full user workflow testing
describe('Settings Management E2E', () => {
  it('should configure Docker settings successfully', async () => {
    // Test complete user journey
    // Verify UI updates and feedback
    // Check persistence and validation
  })
})
```

### 2.10 Deployment and Maintenance

#### Environment Configuration
```bash
# Required environment variables
CLOUDFLARE_API_TIMEOUT=10000
DOCKER_VALIDATION_TIMEOUT=5000
AZURE_VALIDATION_TIMEOUT=15000
SETTINGS_CACHE_TTL=300000
```

### 2.11 System Integration

#### Authentication Integration
- **OAuth Integration**: Leverage existing Google OAuth for user context
- **Session Management**: Integrate with existing session handling
- **API Key Support**: Extend existing API key system for programmatic access
- **Permission Model**: Build on existing user authorization framework

#### Logging Integration  
- **Pino Logger**: Use existing structured logging with correlation IDs
- **Audit Events**: Emit structured events for configuration changes
- **Request Correlation**: Track settings changes across request lifecycle
- **Log Redaction**: Automatically redact sensitive values from logs

#### Frontend Integration
- **React Router**: New `/settings` routes with nested pages
- **Authentication Guards**: Protect settings routes with existing auth system
- **UI Components**: Leverage existing shadcn components and patterns
- **State Management**: Integrate with existing React Query setup

## 3. Technical Design and Architecture Summary

The Settings and Configuration Management system will be implemented as a comprehensive configuration layer that extends Mini Infra's existing architecture. The design emphasizes security, validation, and user experience while maintaining consistency with the current technology stack.

**Core Architecture Pattern**: The system follows a layered architecture with dedicated service classes for external validation, encrypted storage for sensitive data, and a comprehensive audit trail. The frontend provides intuitive interfaces for system administrators to manage both settings and system-wide preferences, with real-time validation feedback and optimistic updates.

**Key Technical Decisions**: 
- Service-oriented architecture for external API validation with circuit breaker patterns
- Comprehensive audit logging for compliance and troubleshooting
- React Query-based state management with optimistic updates and error recovery

**Integration Strategy**: The system integrates seamlessly with existing authentication, logging, and UI frameworks. It extends the current Prisma schema, leverages existing middleware patterns, and follows established API conventions. The frontend builds upon existing shadcn components and React Router patterns.
