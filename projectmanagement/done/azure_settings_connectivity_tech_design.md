# Azure Settings and Connectivity - Technical Design Document

## 1. Feature Breakdown

### Core Components

- **Azure Configuration Management Service**
  - Connection string validation and storage
  - Storage account metadata retrieval
  - Container access verification
  - Health monitoring and connectivity testing

- **Settings API Layer**
  - RESTful endpoints for Azure settings CRUD operations
  - Validation endpoint for connection testing
  - Connectivity status retrieval endpoints

- **Frontend Settings Interface**
  - Azure configuration form with secure input handling
  - Real-time validation feedback
  - Connection testing UI with status indicators
  - Container listing and metadata display

- **Background Monitoring System**
  - Scheduled connectivity health checks
  - Circuit breaker pattern implementation
  - Exponential backoff retry logic
  - Status recording and reporting

- **Data Persistence Layer**
  - Connection string storage
  - Connectivity status history
  - Audit trail for configuration changes

## 2. Implementation Considerations

### 2.1 Software Design

#### Backend Service Architecture
- **ConfigurationService Base Class**: Abstract base providing common functionality for all configuration services
- **AzureConfigService Implementation**: Extends base class with Azure Storage-specific logic
- **Service Factory Pattern**: Factory for creating service instances with proper dependency injection
- **Repository Pattern**: Database operations abstracted through Prisma ORM
- **Singleton Pattern**: Service instances managed as singletons for connection pooling

#### API Design
- **RESTful Endpoints**:
  - `GET /api/settings/azure` - Retrieve current configuration
  - `PUT /api/settings/azure` - Update configuration
  - `POST /api/settings/azure/validate` - Test connection
  - `DELETE /api/settings/azure` - Remove configuration
  - `GET /api/connectivity/azure` - Get connectivity status

#### Frontend Architecture
- **React Component Hierarchy**:
  - `AzureSettingsPage` - Main container component
  - `AzureConfigForm` - Form component with validation
  - `ConnectionTestButton` - Manual test trigger
  - `ConnectivityStatusCard` - Status display component
  - `ContainerListPanel` - Container metadata display

- **State Management**:
  - React Query for server state (settings, validation results)
  - React Hook Form for form state management
  - Zod schemas for client-side validation
  - Custom hooks for Azure-specific operations

### 2.2 Software Libraries

#### Backend Dependencies
- **@azure/storage-blob** (v12.28.0) - Official Azure Storage SDK
  - BlobServiceClient for connection management
  - Container operations and metadata retrieval
  - Built-in retry policies and timeout handling

- **Existing Dependencies**:
  - Prisma - Database ORM (already in use)
  - Zod - Schema validation (already in use)
  - Pino - Structured logging (already in use)
  - Express - Web framework (already in use)

#### Frontend Dependencies
- **No new dependencies required** - All functionality uses existing:
  - React Query - Data fetching and caching
  - React Hook Form - Form management
  - Zod - Schema validation
  - shadcn/ui - UI components
  - Tailwind CSS - Styling

### 2.3 External Dependencies

#### Azure Storage Account
- **Connection Requirements**:
  - Valid connection string with Account Name, Account Key, and Protocol
  - Network access to Azure Storage endpoints
  - Proper RBAC permissions for container operations

- **API Endpoints**:
  - `https://{account}.blob.core.windows.net` - Blob storage endpoint
  - Account info endpoint for validation
  - Container listing and metadata endpoints

#### Network Requirements
- **Firewall Rules**: Outbound HTTPS (443) to Azure endpoints
- **DNS Resolution**: Ability to resolve Azure domain names
- **Proxy Support**: Honor system proxy settings if configured

### 2.4 Important Flows

#### Configuration Flow
1. User enters connection string in UI form
2. Client-side validation using Zod schema
3. API request to update settings endpoint
4. Server validates connection string format
5. Connection test performed against Azure
6. Encrypted storage in database
7. Success/failure response to client
8. UI updates with validation status

#### Validation Flow
1. Retrieve connection string from database
2. Create BlobServiceClient instance
3. Call getAccountInfo with timeout wrapper
4. Attempt container listing (limited to 10)
5. Extract metadata (account name, SKU, containers)
6. Record connectivity status in database
7. Return validation result with metadata

#### Background Monitoring Flow
1. Scheduler triggers every 5 minutes
2. Check circuit breaker status
3. If open, skip check (exponential backoff)
4. Retrieve all Azure configurations
5. Validate each configuration in parallel
6. Update connectivity status records
7. Reset or increment circuit breaker counters

### 2.5 Database Changes

#### Schema Updates
```prisma
// Existing SystemSettings table
model SystemSettings {
  // Used for Azure configuration storage
  // category: 'azure'
  // key: 'connection_string' | 'storage_account_name'
  // value: Encrypted connection string or account name
  // isEncrypted: true for connection_string
}

// Existing ConnectivityStatus table  
model ConnectivityStatus {
  // Used for Azure connectivity monitoring
  // service: 'azure'
  // metadata: JSON with account info, containers, SKU
}
```

#### Data Migrations
- No schema changes required (using existing tables)
- Seed data for default Azure settings (optional)
- Encryption key generation for sensitive data

### 2.6 New System Dependencies

#### Runtime Dependencies
- **Azure Storage Access**: Required for functionality
- **HTTPS Outbound**: Network connectivity to Azure

#### Development Dependencies
- **Azure Storage Emulator** (optional): For local testing
- **Mock Azure Responses**: For unit testing

### 2.7 Scalability and Performance

#### Caching Strategy
- **Connection Client Caching**: Reuse BlobServiceClient instances
- **Container Metadata Cache**: 5-minute TTL for container listings
- **Validation Result Cache**: 30-second cache for repeated validations

#### Performance Optimizations
- **Parallel Container Queries**: Concurrent container operations
- **Pagination Support**: Limit container listings to 50 items
- **Timeout Protection**: 15-second timeout for Azure operations
- **Connection Pooling**: Reuse HTTPS connections

#### Scalability Considerations
- **Rate Limiting**: Respect Azure API rate limits
- **Batch Operations**: Group container operations when possible
- **Database Connection Pool**: Managed by Prisma
- **Horizontal Scaling**: Stateless service design

### 2.8 Security Considerations

#### Data Protection
- **Secure Transmission**: HTTPS for all API calls
- **Input Sanitization**: Zod validation on all inputs
- **SQL Injection Prevention**: Parameterized queries via Prisma

#### Access Control
- **Authentication Required**: All endpoints protected by JWT
- **User Context**: Track who modifies settings
- **Audit Logging**: All configuration changes logged
- **API Key Rotation**: Support for connection string updates

#### Secret Management
- **Environment Variables**: Encryption keys in .env
- **No Hardcoding**: No secrets in source code
- **Redaction in Logs**: Connection strings never logged
- **Secure Display**: Masked input fields in UI

### 2.9 Testing Strategy

#### Unit Tests
- **Service Layer Tests**: 
  - Connection string validation
  - Metadata extraction
  - Error handling scenarios
  - Timeout behavior

- **API Endpoint Tests**:
  - Authentication verification
  - Request validation
  - Response formatting
  - Error responses

#### Integration Tests
- **Azure Connectivity Tests**:
  - Mock Azure responses
  - Network failure scenarios
  - Authentication failures
  - Rate limiting behavior

- **Database Integration**:
  - Settings persistence
  - Connectivity status recording
  - Concurrent access handling

### 2.10 Deployment and Maintenance

#### Deployment Requirements
- **Environment Variables**:
  ```env
  AZURE_API_TIMEOUT=15000
  CONNECTIVITY_CHECK_INTERVAL=300000
  ```

- **Database Migrations**: Run Prisma migrations
- **Service Restart**: Graceful shutdown/startup

#### Maintenance Tasks
- **Log Rotation**: Connectivity status cleanup (30-day retention)
- **Cache Invalidation**: Manual cache clear capability
- **Connection String Rotation**: Support for key updates
- **Performance Tuning**: Timeout and retry adjustments

### 2.11 System Integration

#### Existing System Integration
- **Authentication System**: Uses existing Passport.js setup
- **Logging System**: Integrates with Pino logger
- **Database Layer**: Uses existing Prisma client
- **API Framework**: Extends existing Express routes
- **Frontend Framework**: Uses existing React Query setup

#### Service Dependencies
- **Docker Service**: Independent, no dependencies
- **Cloudflare Service**: Independent, no dependencies
- **Settings Service**: Shared database tables
- **Monitoring Service**: Provides data to dashboard

#### Data Flow Integration
- **Settings Management**: Part of unified settings interface
- **Connectivity Monitoring**: Feeds into status dashboard
- **Activity Logging**: Records all Azure operations
- **User Preferences**: Respects user display preferences

## 3. Technical Design and Architecture Summary

The Azure Settings and Connectivity feature provides a comprehensive solution for managing Azure Storage Account connections within the Mini Infra application. The implementation leverages existing architectural patterns and dependencies while introducing minimal new complexity.

### Key Design Decisions

1. **Service-Oriented Architecture**: The AzureConfigService extends the existing ConfigurationService base class, ensuring consistency with other configuration services (Docker, Cloudflare).

2. **Security-First Design**: All sensitive data (connection strings) are encrypted at rest using AES-256 encryption, with additional protections including input masking, log redaction, and audit trails.

3. **Resilient Connectivity**: The implementation includes multiple layers of resilience including timeouts, retries with exponential backoff, circuit breakers, and graceful degradation.

4. **Real-Time Monitoring**: Background health checks run every 5 minutes with results stored in the database, providing historical connectivity data and enabling trend analysis.

5. **User-Friendly Interface**: The React-based frontend provides immediate feedback through real-time validation, clear error messages, and visual status indicators.

### Implementation Priorities

1. **Phase 1**: Core configuration management (CRUD operations, encryption, basic validation)
2. **Phase 2**: Advanced validation and container metadata retrieval
3. **Phase 3**: Background monitoring and circuit breaker implementation
4. **Phase 4**: Frontend UI with real-time feedback
5. **Phase 5**: Integration testing and performance optimization

### Success Metrics

- **Connectivity Success Rate**: > 99% for valid configurations
- **Validation Response Time**: < 3 seconds for connection tests
- **UI Responsiveness**: < 100ms for user interactions
- **Error Recovery Time**: < 30 seconds for transient failures
- **Security Compliance**: 100% encryption of sensitive data

The design ensures seamless integration with the existing Mini Infra architecture while providing robust, secure, and user-friendly Azure Storage management capabilities.