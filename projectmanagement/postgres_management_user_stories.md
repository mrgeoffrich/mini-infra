# Feature: PostgreSQL Database Management

## User Story 1: Database Schema and Prisma Models

**Goal:** Create database schema for PostgreSQL management with all required models and relationships

**Status:** Done

**Tasks:**

1. Add PostgresDatabase model to Prisma schema with encrypted connection string field
2. Add BackupConfiguration model with scheduling and Azure storage settings
3. Add BackupOperation model for tracking backup jobs
4. Add RestoreOperation model for tracking restore jobs
5. Create relationships with User model for ownership
6. Run Prisma migration and generate client

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 2: Database Configuration Service

**Goal:** Create backend service for database CRUD operations with encryption support

**Status:** Done

**Tasks:**

1. Create DatabaseConfigService class in server/src/services/postgres-config.ts
2. Implement connection string encryption/decryption using crypto-js
3. Add CRUD methods for database configurations
4. Implement database list retrieval with user filtering
5. Add validation for database configuration fields
6. Create error handling for database operations

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 3: Database API Endpoints and Type Definitions

**Goal:** Create RESTful API endpoints for database management with proper type definitions

**Status:** Done

**Tasks:**

1. Create PostgreSQL type definitions in @mini-infra/types package
2. Create router file server/src/routes/postgres-databases.ts
3. Implement GET /api/postgres/databases endpoint
4. Implement POST /api/postgres/databases endpoint
5. Implement PUT /api/postgres/databases/:id endpoint
6. Implement DELETE /api/postgres/databases/:id endpoint
7. Add Zod validation schemas for request/response
8. Register routes in main Express app

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 4: Connection Validation Service

**Goal:** Implement database connection testing and health check functionality

**Status:** Done

**Tasks:**

1. Install pg package for PostgreSQL client
2. Create connection validation method in DatabaseConfigService
3. Implement POST /api/postgres/databases/:id/test endpoint
4. Add health check logic with timeout handling
5. Store health check results in database
6. Add error messages for common connection issues

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 5: Backup Configuration Service

**Goal:** Create service for managing backup configurations and schedules

**Status:** Done

**Tasks:**

1. Create BackupConfigService class in server/src/services/backup-config.ts
2. Implement CRUD operations for backup configurations
3. Add cron expression validation
4. Calculate next scheduled backup time
5. Implement Azure container validation
6. Add retention policy management

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 6: Backup Configuration API

**Goal:** Create API endpoints for backup configuration management

**Status:** Done

**Tasks:**

1. Create backup configuration type definitions
2. Create router file server/src/routes/postgres-backup-configs.ts
3. Implement GET /api/postgres/backup-configs/:databaseId endpoint
4. Implement POST /api/postgres/backup-configs endpoint
5. Implement DELETE /api/postgres/backup-configs/:id endpoint
6. Add validation schemas for backup configuration

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 7: Docker Execution Service

**Goal:** Create service to execute Docker containers for backup and restore operations

**Status:** Done

**Tasks:**

1. Create DockerExecutor class in server/src/services/docker-executor.ts
2. Implement container run method with environment variables
3. Add container output streaming and monitoring
4. Implement container cleanup on completion
5. Add timeout handling for long-running operations
6. Create error handling for Docker API failures

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 8: Backup Executor Service

**Goal:** Create service to orchestrate backup operations using Docker containers

**Status:** Done

**Tasks:**

1. Install bull package for job queue management
2. Create BackupExecutorService in server/src/services/backup-executor.ts
3. Implement backup job queue setup
4. Add backup execution logic using DockerExecutor
5. Verify backup files in Azure Storage after completion
6. Update backup operation status in database
7. Implement error handling and retry logic

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 9: Backup Operations API

**Goal:** Create API endpoints for backup execution and monitoring

**Status:** Done

**Tasks:**

1. Create backup operation type definitions
2. Create router file server/src/routes/postgres-backups.ts
3. Implement GET /api/postgres/backups/:databaseId endpoint
4. Implement POST /api/postgres/backups/:databaseId/manual endpoint
5. Implement GET /api/postgres/backups/:backupId/status endpoint
6. Implement DELETE /api/postgres/backups/:backupId endpoint
7. Add progress tracking endpoint

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 10: Azure Storage Service Enhancement

**Goal:** Enhance Azure Storage service for PostgreSQL backup operations

**Status:** Done

**Tasks:**

1. Extend existing Azure service for backup file operations
2. Add backup file listing with metadata
3. Implement backup file download for restore
4. Add retention policy enforcement
5. Create backup metadata indexing
6. Implement backup file validation after upload

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 11: Restore Executor Service

**Goal:** Create service to handle database restore operations from Azure backups

**Status:** Done

**Tasks:**

1. Create RestoreExecutorService in server/src/services/restore-executor.ts
2. Implement restore execution using DockerExecutor
3. Add backup file validation before restore
4. Implement restore progress tracking
5. Add rollback mechanism on failure
6. Update restore operation status in database

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 12: Restore Operations API

**Goal:** Create API endpoints for restore operations

**Status:** Done

**Tasks:**

1. Create restore operation type definitions
2. Create router file server/src/routes/postgres-restore.ts
3. Implement POST /api/postgres/restore/:databaseId endpoint
4. Implement GET /api/postgres/restore/:operationId/status endpoint
5. Add backup browser endpoint for available backups
6. Implement restore confirmation workflow

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 13: Scheduling Service

**Goal:** Implement cron-based backup scheduling system

**Status:** Done

**Tasks:**

1. Install node-cron package
2. Create BackupSchedulerService in server/src/services/backup-scheduler.ts
3. Implement cron job registration for scheduled backups
4. Add job persistence across server restarts
5. Create schedule management (enable/disable)
6. Implement next run time calculation
7. Add scheduled backup execution trigger

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 14: Progress Tracking Service

**Goal:** Create real-time operation progress tracking system

**Status:** Done

**Tasks:**

1. Create ProgressTrackerService in server/src/services/progress-tracker.ts
2. Implement progress update mechanism
3. Add polling endpoint for progress retrieval
4. Create progress event broadcasting
5. Implement operation history tracking
6. Add cleanup for completed operations

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 15: System Settings for Docker Images

**Goal:** Add system settings for configuring backup/restore Docker images

**Status:** Done

**Tasks:**

1. Add new settings category for PostgreSQL Docker images
2. Create settings for backup container image
3. Create settings for restore container image
4. Add validation for Docker image format
5. Update settings service to handle new configuration
6. Add default values for Docker images

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 16: Backend Tests for PostgreSQL Features

**Goal:** Create comprehensive test coverage for all PostgreSQL management features

**Status:** Done

**Tasks:**

1. Create tests for DatabaseConfigService
2. Create tests for BackupConfigService
3. Create tests for backup and restore executors
4. Create API endpoint integration tests
5. Add tests for scheduling service
6. Create tests for progress tracking
7. Mock Docker operations for testing

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 17: Frontend React Query Hooks

**Goal:** Create React Query hooks for PostgreSQL management features

**Status:** Done

**Tasks:**

1. Create usePostgresDatabases hook for database list
2. Create usePostgresDatabase hook for single database
3. Create useCreateDatabase and useUpdateDatabase mutations
4. Create useBackupConfig hooks
5. Create useBackupOperations hooks
6. Create useRestoreOperations hooks
7. Add proper error handling and cache invalidation

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 18: Database Management UI

**Goal:** Create frontend interface for database CRUD operations

**Status:** Done

**Tasks:**

1. Create PostgreSQL settings page at /settings/postgres
2. Add database list component with status indicators
3. Create add/edit database modal with form validation
4. Implement delete confirmation dialog
5. Add connection test button with feedback
6. Display health status badges
7. Add routing and navigation integration

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 19: Backup Configuration UI

**Goal:** Create frontend interface for backup scheduling and configuration

**Status:** Done

**Tasks:**

1. Create backup configuration component
2. Add cron expression builder/input
3. Implement Azure container selection
4. Add retention policy configuration
5. Create schedule enable/disable toggle
6. Display next scheduled backup time
7. Add manual backup trigger button

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 20: Restore Browser UI

**Goal:** Create frontend interface for browsing and restoring backups

**Status:** Not Started

**Tasks:**

1. Create backup browser component
2. Display available backups with metadata
3. Add filtering and sorting options
4. Create restore confirmation dialog
5. Implement target database selection
6. Add restore progress display
7. Show restore operation history

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 21: Progress Indicators UI

**Goal:** Create real-time progress display components for operations

**Status:** Not Started

**Tasks:**

1. Create progress bar component for active operations
2. Implement real-time polling for progress updates
3. Add operation status badges
4. Create operation history list
5. Add error display with details
6. Implement auto-refresh for active operations
7. Add cancel operation functionality

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.