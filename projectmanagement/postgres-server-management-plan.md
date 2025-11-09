# PostgreSQL Server Management Feature - Implementation Plan

## Executive Summary

This document outlines the plan for introducing PostgreSQL Server Management to Mini Infra. This feature will allow users to connect to PostgreSQL servers with admin credentials and manage the entire server, including creating databases, managing users, and controlling access - separate from the existing database-specific backup/restore functionality.

## Current State Analysis

### Existing PostgreSQL Features
The application currently provides:
- **Database Connection Management**: Store connection details for individual PostgreSQL databases
- **Backup & Restore**: Automated and manual backups to Azure Blob Storage
- **Health Monitoring**: Periodic connection health checks
- **Progress Tracking**: Real-time operation monitoring
- **Scheduling**: Cron-based backup scheduling

### Current Data Model
- `PostgresDatabase` - Individual database connections
- `BackupConfiguration` - Per-database backup settings
- `BackupOperation` - Backup execution tracking
- `RestoreOperation` - Restore execution tracking

### Key Limitation
Users currently manage individual database connections in isolation. There's no concept of a "server" with multiple databases, users, and server-level management capabilities.

---

## Proposed Solution: PostgreSQL Server Management

### Vision
Enable users to manage entire PostgreSQL servers through an admin connection, providing:
1. **Server-level Operations**: Connect once with admin credentials, manage everything
2. **Database Lifecycle**: Create, configure, and delete databases
3. **User & Access Management**: Create users, manage roles, grant/revoke permissions
4. **Simplified Workflows**: One-click "create database + user" for common application scenarios
5. **Server Monitoring**: Health, performance, and resource utilization tracking

### Design Principle
Keep this feature **separate** from existing database backup/restore functionality initially. This allows parallel development and easier future integration.

---

## Phase 1: Foundation (MVP)

### 1.1 Database Schema

#### New Models

**PostgresServer**
```prisma
model PostgresServer {
  id                String   @id @default(cuid())
  name              String   @unique // User-friendly name
  host              String
  port              Int      @default(5432)
  adminUsername     String   // Admin user (e.g., 'postgres')
  connectionString  String   // Encrypted connection string with admin password
  sslMode           String   @default("prefer") // prefer/require/disable
  tags              String?  // JSON array of tags

  // Health monitoring
  healthStatus      String   @default("unknown") // healthy/unhealthy/unknown
  lastHealthCheck   DateTime?
  serverVersion     String?  // e.g., "PostgreSQL 15.3"

  // Metadata
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  userId            String
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  // Relationships
  databases         ManagedDatabase[]
  users             ManagedDatabaseUser[]

  @@index([userId])
  @@index([healthStatus])
}
```

**ManagedDatabase**
```prisma
model ManagedDatabase {
  id               String   @id @default(cuid())
  serverId         String
  server           PostgresServer @relation(fields: [serverId], references: [id], onDelete: Cascade)

  // Database info
  databaseName     String   // Name on the server
  owner            String   // Database owner role
  encoding         String   @default("UTF8")
  collation        String?
  template         String   @default("template0")

  // Metadata from server
  sizeBytes        BigInt?  // Database size
  connectionLimit  Int      @default(-1) // -1 = unlimited

  // Tracking
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  lastSyncedAt     DateTime? // Last time we synced with server

  // Relationships
  grants           DatabaseGrant[]

  @@unique([serverId, databaseName])
  @@index([serverId])
}
```

**ManagedDatabaseUser**
```prisma
model ManagedDatabaseUser {
  id              String   @id @default(cuid())
  serverId        String
  server          PostgresServer @relation(fields: [serverId], references: [id], onDelete: Cascade)

  // User info
  username        String
  canLogin        Boolean  @default(true)
  isSuperuser     Boolean  @default(false)
  connectionLimit Int      @default(-1)

  // Password management
  passwordHash    String?  // Encrypted - for our records only
  passwordSetAt   DateTime?

  // Tracking
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  lastSyncedAt    DateTime?

  // Relationships
  grants          DatabaseGrant[]

  @@unique([serverId, username])
  @@index([serverId])
}
```

**DatabaseGrant**
```prisma
model DatabaseGrant {
  id          String   @id @default(cuid())
  databaseId  String
  database    ManagedDatabase @relation(fields: [databaseId], references: [id], onDelete: Cascade)
  userId      String
  user        ManagedDatabaseUser @relation(fields: [userId], references: [id], onDelete: Cascade)

  // Permissions
  canConnect  Boolean  @default(true)
  canCreate   Boolean  @default(false)
  canTemp     Boolean  @default(false)

  // Schema-level privileges (on public schema)
  canCreateSchema   Boolean @default(false)
  canUsageSchema    Boolean @default(true)

  // Table-level privileges (ALL TABLES)
  canSelect   Boolean  @default(true)
  canInsert   Boolean  @default(true)
  canUpdate   Boolean  @default(true)
  canDelete   Boolean  @default(true)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([databaseId, userId])
  @@index([databaseId])
  @@index([userId])
}
```

### 1.2 Backend Services

**PostgresServerService** (`server/src/services/postgres-server/server-manager.ts`)
- CRUD operations for PostgresServer records
- Connection testing with admin credentials
- Health check monitoring
- Server version detection
- Encryption/decryption of admin credentials

**DatabaseManagementService** (`server/src/services/postgres-server/database-manager.ts`)
- List all databases on a server (via SQL query to pg_database)
- Create database with options (encoding, collation, template, owner)
- Drop database (with safety checks)
- Get database size and metadata
- Sync database list with our ManagedDatabase records

**UserManagementService** (`server/src/services/postgres-server/user-manager.ts`)
- List all users/roles on server (via pg_roles)
- Create user with password
- Drop user (with dependency checks)
- Change user password
- Modify user attributes (connection limit, login ability)
- Sync user list with our ManagedDatabaseUser records

**GrantManagementService** (`server/src/services/postgres-server/grant-manager.ts`)
- Grant database access to user (GRANT CONNECT)
- Revoke database access
- Grant schema privileges (CREATE, USAGE on schemas)
- Grant table privileges (SELECT, INSERT, UPDATE, DELETE on all tables)
- Revoke privileges
- Query current grants from server (pg_database_acl, pg_namespace_acl)

**ServerHealthScheduler** (`server/src/services/postgres-server/health-scheduler.ts`)
- Periodic health checks for all PostgresServer records
- Update server version, health status
- Sync database and user lists periodically

### 1.3 Backend API Routes

**Server Management** (`/api/postgres-server/servers`)
```typescript
GET    /api/postgres-server/servers              // List all servers
POST   /api/postgres-server/servers              // Create server connection
GET    /api/postgres-server/servers/:id          // Get server details
PUT    /api/postgres-server/servers/:id          // Update server
DELETE /api/postgres-server/servers/:id          // Delete server
POST   /api/postgres-server/servers/:id/test     // Test connection
GET    /api/postgres-server/servers/:id/info     // Get server info (version, uptime, etc.)
```

**Database Management** (`/api/postgres-server/servers/:serverId/databases`)
```typescript
GET    /api/postgres-server/servers/:serverId/databases           // List databases
POST   /api/postgres-server/servers/:serverId/databases           // Create database
GET    /api/postgres-server/servers/:serverId/databases/:dbId     // Get database details
DELETE /api/postgres-server/servers/:serverId/databases/:dbId     // Drop database
POST   /api/postgres-server/servers/:serverId/databases/sync      // Sync with server
```

**User Management** (`/api/postgres-server/servers/:serverId/users`)
```typescript
GET    /api/postgres-server/servers/:serverId/users              // List users
POST   /api/postgres-server/servers/:serverId/users              // Create user
GET    /api/postgres-server/servers/:serverId/users/:userId      // Get user details
PUT    /api/postgres-server/servers/:serverId/users/:userId      // Update user
DELETE /api/postgres-server/servers/:serverId/users/:userId      // Drop user
POST   /api/postgres-server/servers/:serverId/users/:userId/password  // Change password
POST   /api/postgres-server/servers/:serverId/users/sync         // Sync with server
```

**Grant Management** (`/api/postgres-server/grants`)
```typescript
GET    /api/postgres-server/servers/:serverId/databases/:dbId/grants  // List grants for database
POST   /api/postgres-server/grants                                    // Create grant
PUT    /api/postgres-server/grants/:grantId                           // Update grant permissions
DELETE /api/postgres-server/grants/:grantId                           // Revoke grant
GET    /api/postgres-server/users/:userId/grants                      // List grants for user
```

**Quick Setup Workflows** (`/api/postgres-server/workflows`)
```typescript
POST   /api/postgres-server/workflows/create-app-database
// Body: { serverId, databaseName, username, password }
// Creates database + user + grants all permissions
// Returns: { database, user, grant, connectionString }
```

### 1.4 Frontend Pages

**PostgreSQL Server List** (`/postgres-server`)
- Table showing all PostgresServer records
- Columns: Name, Host, Server Version, Health Status, # Databases, # Users, Actions
- "Add Server" button
- Action buttons: View Details, Edit, Delete
- Health status badges (similar to existing database health)

**Server Details Page** (`/postgres-server/:serverId`)
- Tabbed interface:
  1. **Overview Tab**
     - Server connection details (host, port, version)
     - Health status
     - Quick stats: # databases, # users, total size
     - Recent activity feed
     - "Sync from Server" button (refresh database/user lists)

  2. **Databases Tab**
     - Table of ManagedDatabase records
     - Columns: Name, Owner, Size, Encoding, Actions
     - "Create Database" button
     - Actions: View Grants, Drop Database
     - Real-time sync status indicator

  3. **Users Tab**
     - Table of ManagedDatabaseUser records
     - Columns: Username, Can Login, Is Superuser, # Grants, Actions
     - "Create User" button
     - Actions: Edit, Change Password, View Grants, Drop User
     - Filter: Show system users / Hide system users toggle

  4. **Quick Setup Tab**
     - Workflow wizard: "Create Application Database"
     - Form: Database name, Username, Password
     - One-click creation of database + user + full permissions
     - Shows generated connection string for application use

### 1.5 Frontend Components

**ServerModal** (`client/src/components/postgres-server/server-modal.tsx`)
- Create/edit PostgresServer form
- Fields: name, host, port, admin username, admin password, SSL mode, tags
- Test connection button

**DatabaseModal** (`client/src/components/postgres-server/database-modal.tsx`)
- Create database form
- Fields: database name, owner (dropdown of users), encoding, collation, template
- Advanced options collapsible section

**UserModal** (`client/src/components/postgres-server/user-modal.tsx`)
- Create/edit user form
- Fields: username, password, can login checkbox, is superuser checkbox, connection limit

**GrantEditor** (`client/src/components/postgres-server/grant-editor.tsx`)
- Multi-select interface for granting permissions
- Checkboxes: CONNECT, CREATE, SELECT, INSERT, UPDATE, DELETE
- Shows current grants for user on a database
- Quick presets: "Read Only", "Read/Write", "Full Access", "No Access"

**QuickSetupWizard** (`client/src/components/postgres-server/quick-setup-wizard.tsx`)
- Multi-step form for creating database + user
- Step 1: Database details
- Step 2: User credentials
- Step 3: Review and confirm
- Final step: Show connection string with copy button

### 1.6 Shared Types

**Server Types** (`lib/types/postgres-server.ts`)
```typescript
export interface PostgresServer {
  id: string;
  name: string;
  host: string;
  port: number;
  adminUsername: string;
  sslMode: 'prefer' | 'require' | 'disable';
  tags: string[];
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  lastHealthCheck: string | null;
  serverVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedDatabase {
  id: string;
  serverId: string;
  databaseName: string;
  owner: string;
  encoding: string;
  collation: string | null;
  template: string;
  sizeBytes: number | null;
  connectionLimit: number;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
}

export interface ManagedDatabaseUser {
  id: string;
  serverId: string;
  username: string;
  canLogin: boolean;
  isSuperuser: boolean;
  connectionLimit: number;
  passwordSetAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
}

export interface DatabaseGrant {
  id: string;
  databaseId: string;
  userId: string;
  canConnect: boolean;
  canCreate: boolean;
  canTemp: boolean;
  canCreateSchema: boolean;
  canUsageSchema: boolean;
  canSelect: boolean;
  canInsert: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  createdAt: string;
  updatedAt: string;
}

// API Request/Response types
export interface CreatePostgresServerRequest {
  name: string;
  host: string;
  port: number;
  adminUsername: string;
  adminPassword: string;
  sslMode: 'prefer' | 'require' | 'disable';
  tags?: string[];
}

export interface CreateManagedDatabaseRequest {
  databaseName: string;
  owner?: string;
  encoding?: string;
  collation?: string;
  template?: string;
  connectionLimit?: number;
}

export interface CreateManagedUserRequest {
  username: string;
  password: string;
  canLogin?: boolean;
  isSuperuser?: boolean;
  connectionLimit?: number;
}

export interface CreateDatabaseGrantRequest {
  databaseId: string;
  userId: string;
  canConnect?: boolean;
  canCreate?: boolean;
  canSelect?: boolean;
  canInsert?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
}

export interface QuickSetupRequest {
  serverId: string;
  databaseName: string;
  username: string;
  password: string;
}

export interface QuickSetupResponse {
  database: ManagedDatabase;
  user: ManagedDatabaseUser;
  grant: DatabaseGrant;
  connectionString: string; // For application use
}
```

---

## Phase 2: Enhanced Features

### 2.1 Advanced Monitoring

**Server Metrics Dashboard**
- Active connections (per database)
- Database sizes with trend graphs
- Query performance metrics
- Cache hit ratio
- Connection pool utilization

**Active Connections Viewer**
- Real-time list of active connections
- Details: PID, user, database, query, duration
- Kill connection button (with confirmation)

**Database Size Tracking**
- Historical size data
- Growth trends and projections
- Alert when database exceeds threshold

### 2.2 Extension Management

**Extension Service** (`extension-manager.ts`)
- List available extensions on server (from pg_available_extensions)
- List installed extensions per database (from pg_extension)
- Install extension to database (CREATE EXTENSION)
- Uninstall extension (DROP EXTENSION)

**Extension UI**
- Extensions tab on server details page
- Table showing: Extension name, Installed version, Available version, Installed in databases
- "Install to Database" dropdown
- Popular extensions highlighted (PostGIS, pg_trgm, uuid-ossp, etc.)

### 2.3 Schema Management

**Schema Service** (`schema-manager.ts`)
- List schemas in a database
- Create schema
- Drop schema
- Grant schema permissions to users

**Schema UI**
- Schema tab on database details
- Table of schemas with owner, size
- Create schema button
- Manage permissions per schema

### 2.4 Maintenance Operations

**Maintenance Service** (`maintenance-manager.ts`)
- Execute VACUUM on database/table
- Execute ANALYZE on database/table
- Execute REINDEX on database/index
- Schedule maintenance operations

**Maintenance UI**
- Maintenance tab on server details
- Manual maintenance triggers
- Scheduled maintenance (cron-based)
- Maintenance history log

## Phase 3: Integration & Advanced Features

### 3.1 Integration with Existing Backup System

**Link PostgresDatabase to PostgresServer**
- Add optional `serverId` field to PostgresDatabase model
- UI to "Import from Server" - select ManagedDatabase and create PostgresDatabase
- Automatically populate connection details from server + database
- Inherit backup configuration from server-level policies

**Server-Level Backup Policies**
- Default backup configuration for all databases on a server
- Override per database if needed

### 3.2 Query Analytics

**Query Statistics Service** (`query-analytics.ts`)
- Enable pg_stat_statements extension
- Query slow queries from pg_stat_statements
- Top queries by execution time, calls, total time

**Query Analytics UI**
- Analytics tab on server details
- Table of slow queries
- Query text, execution count, avg time, total time
- "Explain" button to get query plan

### 3.3 Replication Monitoring

**Replication Service** (`replication-monitor.ts`)
- Detect if server is a primary/replica
- Monitor replication lag
- List connected replicas
- WAL archive status

**Replication UI**
- Replication tab on server details (only shown if replication detected)
- Replication topology diagram
- Lag metrics with alerts

### 3.4 Configuration Management

**Config Service** (`config-manager.ts`)
- Read server configuration (from pg_settings)
- Modify configuration (via ALTER SYSTEM or config files)
- Reload configuration

**Config UI**
- Configuration tab on server details
- Searchable table of settings
- Edit common settings (max_connections, shared_buffers, etc.)
- Validation and recommendations

### 3.5 Security Enhancements

**pg_hba.conf Management**
- Read current pg_hba.conf
- Add/remove connection rules
- Validate and reload

**SSL Certificate Management**
- Upload SSL certificates
- Verify SSL connection
- Force SSL for users

---

## Implementation Roadmap

### Sprint 1: Foundation (2-3 weeks)
- Database schema migration (PostgresServer, ManagedDatabase, ManagedDatabaseUser, DatabaseGrant)
- Backend services: ServerManager, DatabaseManager, UserManager, GrantManager
- Basic API routes for servers, databases, users, grants
- Server health scheduler

### Sprint 2: Frontend - Server List & Details (2 weeks)
- Server list page (`/postgres-server`)
- Server details page (`/postgres-server/:serverId`) with Overview tab
- ServerModal component (create/edit server)
- Server health status integration

### Sprint 3: Frontend - Database & User Management (2 weeks)
- Databases tab on server details
- Users tab on server details
- DatabaseModal, UserModal components
- Sync functionality (refresh from server)

### Sprint 4: Grant Management & Quick Setup (1-2 weeks)
- Grant editor component
- Grant management UI
- Quick Setup wizard
- Quick setup API workflow

### Sprint 5: Testing & Refinement (1 week)
- Integration tests for all services
- E2E tests for critical workflows
- Bug fixes and UX improvements
- Documentation

### Sprint 6: Phase 2 Features (2-3 weeks)
- Extension management
- Active connections viewer
- Database size tracking and trends
- Maintenance operations

### Sprint 7: Phase 3 Features (3-4 weeks)
- Integration with existing backup system
- Query analytics
- Replication monitoring (if applicable)
- Configuration management

---

## Technical Considerations

### Security
- **Admin Credentials**: Encrypt connection strings using CryptoJS (same as existing PostgresDatabase)
- **Password Storage**: Store hashed passwords only (for our records), never store plaintext
- **SQL Injection**: Use parameterized queries everywhere, validate all inputs
- **Least Privilege**: Create users with minimal necessary permissions by default
- **Audit Logging**: Log all database creation, user creation, grant changes

### Performance
- **Connection Pooling**: Reuse connections to servers, don't create new connection for every operation
- **Caching**: Cache server metadata (version, databases, users) with TTL
- **Sync Strategy**: Periodic sync in background, manual sync on-demand
- **Pagination**: All list endpoints support pagination

### Error Handling
- **Connection Failures**: Graceful degradation when server unreachable
- **Permission Errors**: Clear messages when admin user lacks permissions
- **Conflict Detection**: Prevent deleting users/databases with dependencies
- **Rollback**: Transaction support for multi-step operations

### Testing Strategy
- **Unit Tests**: All services, especially SQL query building
- **Integration Tests**: Test against real PostgreSQL Docker container
- **E2E Tests**: Critical workflows (create server, create database, create user, grant access)
- **Security Tests**: SQL injection attempts, permission bypass attempts

---

## Database Migration Strategy

### Migration Steps
1. Create new tables: PostgresServer, ManagedDatabase, ManagedDatabaseUser, DatabaseGrant
2. No changes to existing tables (PostgresDatabase, BackupConfiguration, etc.)
3. Add indexes for foreign keys and common queries
4. Future: Add optional serverId to PostgresDatabase for integration

### Rollback Plan
- Keep migrations separate from existing database backup features
- New tables can be dropped without affecting existing functionality
- No breaking changes to existing APIs

---

## User Stories

### Story 1: Connect to PostgreSQL Server
**As a** server administrator
**I want to** connect to my PostgreSQL server with admin credentials
**So that** I can manage multiple databases and users from one place

**Acceptance Criteria:**
- I can add a new server with host, port, admin username, and password
- Connection is tested before saving
- Server health is monitored automatically
- I can see server version and basic info

### Story 2: Create Application Database
**As a** developer
**I want to** quickly create a database and user for my application
**So that** I can get a connection string without manual SQL commands

**Acceptance Criteria:**
- I can use "Quick Setup" wizard
- I enter database name, username, and password
- System creates database, user, and grants all permissions
- I receive a connection string I can copy/paste into my app

### Story 3: Manage Database Users
**As a** DBA
**I want to** create, modify, and delete database users
**So that** I can control who has access to my databases

**Acceptance Criteria:**
- I can create users with passwords
- I can modify user attributes (login ability, connection limit)
- I can change user passwords
- I can delete users (with warnings about dependencies)
- I can see all users and their current grants

### Story 4: Control Database Access
**As a** security-conscious administrator
**I want to** grant and revoke specific permissions to users
**So that** I can implement least-privilege access control

**Acceptance Criteria:**
- I can grant CONNECT, SELECT, INSERT, UPDATE, DELETE per database
- I can use quick presets (Read-Only, Read-Write, Full Access)
- I can revoke permissions
- I can see current grants for a user across all databases
- Changes are applied immediately to the server

### Story 5: Monitor Server Health
**As a** operations engineer
**I want to** monitor my PostgreSQL servers' health and performance
**So that** I can detect issues before they affect applications

**Acceptance Criteria:**
- Server health checks run automatically
- I can see connection status, version, and uptime
- I can view database sizes and growth trends
- I can see active connections per database

---

## Future Enhancements (Beyond Phase 3)

1. **Multi-Server Management**
   - Server groups/clusters
   - Cross-server user synchronization
   - Centralized user management across multiple servers

2. **Backup Integration**
   - Server-level backup policies
   - Backup all databases on a server with one click
   - Differential backups

3. **Migration Tools**
   - Copy database between servers
   - Clone database (create copy on same server)
   - Export/import database structure only

4. **Access Control Policies**
   - Template-based access policies
   - Role hierarchy management
   - Automated user provisioning

5. **Compliance & Auditing**
   - Audit log for all DDL operations
   - Compliance reports (who has access to what)
   - Change tracking and approval workflows

6. **High Availability**
   - Failover configuration
   - Automatic replica promotion
   - Connection pooling with automatic failover

7. **Cost Optimization**
   - Database size alerts and recommendations
   - Unused database detection
   - Storage optimization suggestions

---

## Success Metrics

### Phase 1 Success Criteria
- Users can connect to at least one PostgreSQL server
- Users can create databases and users through the UI
- Users can grant permissions to users on databases
- "Quick Setup" workflow successfully creates database + user in < 30 seconds
- Zero bugs in production for 2 weeks post-launch

### Adoption Metrics
- % of users who connect a server within first week
- Average # of databases created per server
- Average # of users created per server
- % of users who use "Quick Setup" vs. manual creation
- Time saved vs. manual SQL commands (target: 80% reduction)

### Performance Metrics
- Server health check completes in < 2 seconds
- Database/user sync completes in < 5 seconds
- Page load time < 1 second for server details page
- API response time < 500ms for all endpoints

---

## Conclusion

This plan provides a comprehensive roadmap for implementing PostgreSQL Server Management in Mini Infra. The phased approach allows for incremental delivery of value while maintaining code quality and system stability.

**Phase 1** delivers the core MVP: server connections, database management, user management, and grant management with a quick setup workflow.

**Phase 2** adds advanced monitoring and maintenance capabilities.

**Phase 3** integrates with existing features and adds enterprise-grade analytics and security.

The architecture is designed to be:
- **Extensible**: Easy to add new features and integrations
- **Secure**: Admin credentials encrypted, SQL injection protected
- **Performant**: Connection pooling, caching, pagination
- **User-Friendly**: Quick setup workflows, intuitive UI
- **Maintainable**: Clean separation of concerns, comprehensive testing

By keeping this feature separate from existing database backup/restore functionality initially, we reduce risk and allow parallel development. Future integration points are identified for seamless unification when ready.
