# Feature: YoloClaude - Claude Story Runner

## User Story 1: Database Schema for Jobs

**Goal:** Create database models for job management and execution tracking

**Status:** Done

**Tasks:**

1. Add Job model to Prisma schema with fields for userId, repositoryUrl, githubToken (encrypted), storyFile, architectureDoc, branchPrefix, featureBranch, status, createdAt, updatedAt
2. Add JobExecution model with fields for jobId, sessionId, status, progress, startedAt, completedAt, error, logs
3. Add JobLog table with the right fields (jobId, timestamp,  LogEntry), each row should have a distinct id and all logs go in here when a job runs.They are also streamed to the user.
3. Run Prisma migration to create new tables and generate client

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 2: Shared Type Definitions

**Goal:** Define TypeScript types for job-related data structures and API interfaces

**Status:** Done

**Tasks:**

1. Create job.ts in lib/types with Job, JonLog, JobExecution, JobStatus enum, and JobProgress interfaces
2. Create sse.ts in lib/types with SSE event types for job progress, logs, and status updates
3. Add job API request/response types to api.ts including CreateJobRequest, JobResponse, JobListResponse

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 3: Job Service Implementation

**Goal:** Implement service for running the Job

**Status:** Done

**Tasks:**

1. Create server/src/services/git-service.ts that just shells out and does the same steps as @projectmanagement/YoloClaude/oldsrc/*.tx
2. Job continues to run streaming content out.
3. Once the process finishes the job is marked as done. The log remainds for people to review.

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 5: SSE Service Implementation

**Goal:** Implement server-sent events service for real-time job updates

**Status:** Done

**Tasks:**

1. Create server/src/services/sse.ts with SSEService class
2. Implement client connection management with session-based routing
3. Add event broadcasting methods for progress, logs, and status updates
4. Implement connection cleanup and error handling

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 6: Job Queue Service Implementation

**Goal:** Implement Bull-based job queue for managing Claude Code execution

**Status:** Done

**Tasks:**

1. Create server/src/services/job-queue.ts with JobQueueService class
2. Configure Bull queue with in-memory mode and job processing options
3. Ensure the jobs start up correctlyas per Story 3
3. Add error handling, retry logic, and job status management

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 7: Job API Endpoints

**Goal:** Create RESTful API endpoints for job management

**Status:** Done

**Tasks:**

1. Create server/src/routes/jobs.ts with authentication middleware
2. Implement POST /api/jobs for job creation with validation
3. Implement GET /api/jobs for listing user's jobs with pagination
4. Implement GET /api/jobs/:id for job details and GET /api/jobs/:id/stream for SSE connection

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 8: Job API Tests

**Goal:** Write comprehensive tests for job API endpoints

**Status:** Done

**Tasks:**

1. Create server/src/routes/__tests__/jobs.test.ts
2. Write tests for job creation with valid and invalid inputs
3. Test job listing with pagination and user isolation
4. Test error scenarios including authentication failures and validation errors

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 9: Job Management Hooks

**Goal:** Create React hooks for job operations and real-time updates

**Status:** Done

**Tasks:**

1. Create client/src/hooks/use-jobs.ts with useCreateJob mutation hook
2. Implement useJobs query hook for listing jobs with pagination
3. Create useJobStatus hook for real-time job monitoring via SSE
4. Add useJobDetails hook for fetching individual job information

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 10: Job Creation Form Component

**Goal:** Implement job submission form with validation and user feedback

**Status:** Done

**Tasks:**

1. Create client/src/app/yolo-claude/page.tsx with job creation form
2. Implement form validation using React Hook Form and Zod schemas
3. Add GitHub token masking and secure input handling
4. Integrate with useCreateJob hook and handle submission errors

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 11: Job Execution View Component

**Goal:** Implement real-time job monitoring view with log streaming

**Status:** Done

**Tasks:**

1. Create client/src/app/yolo-claude/jobs/[jobId]/page.tsx for job execution view
2. Implement log viewer component with auto-scrolling and formatting
3. Add progress indicators and status badges
4. Integrate SSE connection for real-time updates

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 12: Job List View Component

**Goal:** Implement job history list with status tracking

**Status:** Done

**Tasks:**

1. Create client/src/app/yolo-claude/jobs/page.tsx for job list view
2. Implement data table with job status, timestamps, and repository information
3. Add status badges and filtering capabilities
4. Implement navigation to individual job execution views

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 13: Navigation and Routing Integration

**Goal:** Integrate YoloClaude into application navigation and routing

**Status:** Not Started

**Tasks:**

1. Add YoloClaude routes to client/src/lib/routes.tsx with proper authentication guards
2. Update sidebar navigation in client/src/components/app-sidebar.tsx with YoloClaude menu items
3. Configure breadcrumb navigation for YoloClaude pages
4. Add proper redirects after job creation to job execution view

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.