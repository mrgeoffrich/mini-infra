# User Events Instrumentation Guide

## Table of Contents
1. [Overview](#overview)
2. [When to Use User Events](#when-to-use-user-events)
3. [Quick Start](#quick-start)
4. [Event Types and Categories](#event-types-and-categories)
5. [Instrumentation Patterns](#instrumentation-patterns)
6. [Metadata Best Practices](#metadata-best-practices)
7. [Progress Tracking](#progress-tracking)
8. [Log Management](#log-management)
9. [Error Handling](#error-handling)
10. [Testing Instrumented Code](#testing-instrumented-code)
11. [Performance Considerations](#performance-considerations)
12. [Complete Examples](#complete-examples)

---

## Overview

User Events provide a centralized system for tracking logs and outcomes of important long-running operations in Mini Infra. Unlike application logs which are rotated and lost over time, User Events are stored in the database with configurable retention, making them perfect for:

- **User-facing operation tracking**: Show users what's happening with their deployments, backups, etc.
- **Debugging failed operations**: Query and analyze failures across time periods
- **Audit trails**: Track who did what and when
- **Progress monitoring**: Real-time progress updates for long-running operations
- **Historical analysis**: Analyze trends, failure rates, performance metrics

---

## When to Use User Events

### ✅ **DO use User Events for:**

1. **Long-running operations (> 5 seconds)**
   - Deployments
   - Database backups/restores
   - Certificate creation/renewal
   - Environment startup/shutdown
   - Container cleanup operations
   - Database migrations
   - Bulk operations

2. **User-initiated operations**
   - Manual deployments
   - Backup triggers
   - Certificate requests
   - Configuration changes

3. **Scheduled operations**
   - Automated backups
   - Certificate renewals
   - Cleanup jobs
   - Health checks (if they perform actions)

4. **Critical system operations**
   - Security-related operations (certificate management)
   - Data operations (backups, restores)
   - Infrastructure changes (environment management)

### ❌ **DON'T use User Events for:**

1. **Fast operations (< 5 seconds)**
   - Single API calls
   - Database queries
   - File reads/writes
   - Simple validations

2. **High-frequency operations**
   - Every health check ping
   - Every log line
   - Every API request
   - Periodic status updates (unless they take action)

3. **Internal implementation details**
   - Function calls
   - Internal state changes
   - Cache updates
   - Internal retries

### 💡 **Rule of Thumb:**
If a user would want to see "What happened?" or "How did this go?" after the fact, create a User Event.

---

## Quick Start

### Basic Instrumentation (5 steps)

```typescript
import { UserEventService } from '../services/user-event-service';
import prisma from '../lib/prisma';

// 1. Initialize the service
const userEventService = new UserEventService(prisma);

async function myLongRunningOperation(userId: string, params: any) {
  // 2. Create event at start
  const userEvent = await userEventService.createEvent({
    eventType: 'my_operation',
    eventCategory: 'infrastructure',
    eventName: 'My Long Running Operation',
    userId: userId,
    triggeredBy: 'manual',
    description: `Processing ${params.itemName}`,
    metadata: { itemName: params.itemName },
  });

  try {
    // 3. Update progress as you go
    await performStep1();
    await userEventService.updateEvent(userEvent.id, { progress: 33 });

    await performStep2();
    await userEventService.updateEvent(userEvent.id, { progress: 66 });

    await performStep3();

    // 4. Complete successfully
    await userEventService.updateEvent(userEvent.id, {
      status: 'completed',
      progress: 100,
      resultSummary: 'Operation completed successfully',
    });
  } catch (error) {
    // 5. Handle failures
    await userEventService.updateEvent(userEvent.id, {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      errorDetails: {
        stack: error instanceof Error ? error.stack : undefined,
        params,
      },
    });
    throw error;
  }
}
```

---

## Event Types and Categories

### Event Types

Event types describe **what** operation is being performed. Use specific, descriptive names.

#### Infrastructure Events
- `deployment` - Application deployment
- `deployment_rollback` - Rolling back a deployment
- `deployment_uninstall` - Removing an application
- `environment_start` - Starting an environment
- `environment_stop` - Stopping an environment
- `environment_create` - Creating a new environment
- `environment_delete` - Deleting an environment
- `container_cleanup` - Cleaning up orphaned containers

#### Database Events
- `backup` - Database backup
- `backup_cleanup` - Cleaning up old backups
- `restore` - Database restore
- `database_create` - Creating a database
- `database_delete` - Deleting a database
- `user_create` - Creating a database user
- `user_delete` - Deleting a database user

#### Security Events
- `certificate_create` - Creating a TLS certificate
- `certificate_renew` - Renewing a TLS certificate
- `certificate_revoke` - Revoking a TLS certificate

#### Maintenance Events
- `system_maintenance` - General system maintenance
- `log_cleanup` - Cleaning up old logs
- `cache_cleanup` - Cleaning up cache

#### Configuration Events
- `settings_update` - Updating system settings
- `credentials_update` - Updating credentials

### Event Categories

Event categories describe the **domain** of the operation. Choose one:

- `infrastructure` - Deployments, containers, environments, networking
- `database` - Database operations, backups, restores
- `security` - Certificates, credentials, authentication
- `maintenance` - Cleanup, maintenance, optimization
- `configuration` - Settings changes, configuration updates

### Naming Convention

**Event Names** should be:
- Human-readable and descriptive
- Title case
- Include the resource name if applicable
- Start with a verb (Deploy, Create, Backup, etc.)

**Examples**:
- ✅ "Deploy my-application"
- ✅ "Create TLS Certificate for example.com"
- ✅ "Backup Production Database"
- ❌ "deployment" (too generic)
- ❌ "doing stuff" (not descriptive)

---

## Instrumentation Patterns

### Pattern 1: Simple Operation

For operations with no intermediate steps:

```typescript
async function simpleOperation(userId: string) {
  const userEvent = await userEventService.createEvent({
    eventType: 'simple_operation',
    eventCategory: 'maintenance',
    eventName: 'Simple Operation',
    userId,
    triggeredBy: 'manual',
  });

  try {
    const result = await doWork();

    await userEventService.updateEvent(userEvent.id, {
      status: 'completed',
      resultSummary: `Processed ${result.count} items`,
      metadata: { count: result.count },
    });

    return result;
  } catch (error) {
    await userEventService.updateEvent(userEvent.id, {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}
```

### Pattern 2: Multi-Step Operation with Progress

For operations with distinct steps:

```typescript
async function multiStepOperation(userId: string, config: Config) {
  const userEvent = await userEventService.createEvent({
    eventType: 'multi_step_operation',
    eventCategory: 'infrastructure',
    eventName: `Multi-Step Operation: ${config.name}`,
    userId,
    triggeredBy: 'manual',
    resourceId: config.id,
    resourceType: 'configuration',
    resourceName: config.name,
    metadata: {
      configName: config.name,
      steps: ['initialize', 'process', 'finalize'],
    },
  });

  try {
    // Step 1: Initialize (0-33%)
    await userEventService.appendLogs(userEvent.id, '[1/3] Initializing...');
    await initialize();
    await userEventService.updateEvent(userEvent.id, {
      progress: 33,
      metadata: {
        configName: config.name,
        steps: ['initialize', 'process', 'finalize'],
        currentStep: 'initialize',
        completedSteps: ['initialize'],
      },
    });

    // Step 2: Process (33-66%)
    await userEventService.appendLogs(userEvent.id, '[2/3] Processing...');
    const result = await process();
    await userEventService.updateEvent(userEvent.id, {
      progress: 66,
      metadata: {
        configName: config.name,
        steps: ['initialize', 'process', 'finalize'],
        currentStep: 'process',
        completedSteps: ['initialize', 'process'],
      },
    });

    // Step 3: Finalize (66-100%)
    await userEventService.appendLogs(userEvent.id, '[3/3] Finalizing...');
    await finalize(result);

    await userEventService.updateEvent(userEvent.id, {
      status: 'completed',
      progress: 100,
      resultSummary: 'All steps completed successfully',
      metadata: {
        configName: config.name,
        steps: ['initialize', 'process', 'finalize'],
        completedSteps: ['initialize', 'process', 'finalize'],
      },
    });

    return result;
  } catch (error) {
    await userEventService.updateEvent(userEvent.id, {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      errorDetails: {
        stack: error instanceof Error ? error.stack : undefined,
        config,
      },
    });
    throw error;
  }
}
```

### Pattern 3: Scheduled/Automated Operation

For operations triggered by the system:

```typescript
async function scheduledCleanup() {
  const userEvent = await userEventService.createEvent({
    eventType: 'container_cleanup',
    eventCategory: 'maintenance',
    eventName: 'Scheduled Container Cleanup',
    userId: undefined, // No user, system-triggered
    triggeredBy: 'scheduled',
    description: 'Automated cleanup of orphaned containers',
  });

  try {
    const containers = await findOrphanedContainers();
    await userEventService.appendLogs(
      userEvent.id,
      `Found ${containers.length} orphaned containers`
    );

    const results = {
      removed: [] as string[],
      failed: [] as string[],
    };

    for (const container of containers) {
      try {
        await removeContainer(container.id);
        results.removed.push(container.id);
      } catch (error) {
        results.failed.push(container.id);
      }
    }

    await userEventService.updateEvent(userEvent.id, {
      status: results.failed.length > 0 ? 'completed' : 'completed',
      resultSummary: `Removed ${results.removed.length} containers, ${results.failed.length} failures`,
      metadata: {
        containersFound: containers.length,
        containersRemoved: results.removed.length,
        containersFailed: results.failed.length,
        results,
      },
      logs: JSON.stringify(results, null, 2),
    });
  } catch (error) {
    await userEventService.updateEvent(userEvent.id, {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}
```

### Pattern 4: Operation with Retry Logic

For operations that retry on failure:

```typescript
async function operationWithRetry(userId: string, maxRetries = 3) {
  const userEvent = await userEventService.createEvent({
    eventType: 'operation_with_retry',
    eventCategory: 'infrastructure',
    eventName: 'Operation with Retry',
    userId,
    triggeredBy: 'manual',
    metadata: { maxRetries, attemptNumber: 1 },
  });

  let attemptNumber = 1;

  while (attemptNumber <= maxRetries) {
    try {
      await userEventService.appendLogs(
        userEvent.id,
        `[Attempt ${attemptNumber}/${maxRetries}] Starting...`
      );

      const result = await doWork();

      await userEventService.updateEvent(userEvent.id, {
        status: 'completed',
        resultSummary: `Succeeded on attempt ${attemptNumber}`,
        metadata: { maxRetries, attemptNumber, succeeded: true },
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (attemptNumber >= maxRetries) {
        // Final attempt failed
        await userEventService.updateEvent(userEvent.id, {
          status: 'failed',
          errorMessage: `Failed after ${maxRetries} attempts: ${errorMessage}`,
          metadata: { maxRetries, attemptNumber, succeeded: false },
        });
        throw error;
      }

      // Log retry attempt
      await userEventService.appendLogs(
        userEvent.id,
        `[Attempt ${attemptNumber}/${maxRetries}] Failed: ${errorMessage}. Retrying...`
      );

      await userEventService.updateEvent(userEvent.id, {
        metadata: { maxRetries, attemptNumber: attemptNumber + 1 },
      });

      attemptNumber++;
      await delay(1000 * attemptNumber); // Exponential backoff
    }
  }
}
```

### Pattern 5: Batch Operation

For operations processing multiple items:

```typescript
async function batchOperation(userId: string, items: Item[]) {
  const userEvent = await userEventService.createEvent({
    eventType: 'batch_operation',
    eventCategory: 'maintenance',
    eventName: `Batch Operation: ${items.length} items`,
    userId,
    triggeredBy: 'manual',
    metadata: {
      totalItems: items.length,
      processedItems: 0,
      failedItems: 0,
    },
  });

  const results = {
    succeeded: [] as string[],
    failed: [] as { id: string; error: string }[],
  };

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      try {
        await processItem(item);
        results.succeeded.push(item.id);
      } catch (error) {
        results.failed.push({
          id: item.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // Update progress after each item
      const progress = Math.floor(((i + 1) / items.length) * 100);
      await userEventService.updateEvent(userEvent.id, {
        progress,
        metadata: {
          totalItems: items.length,
          processedItems: i + 1,
          succeededItems: results.succeeded.length,
          failedItems: results.failed.length,
        },
      });
    }

    // Complete
    const status = results.failed.length > 0 ? 'completed' : 'completed';
    await userEventService.updateEvent(userEvent.id, {
      status,
      progress: 100,
      resultSummary: `Processed ${items.length} items: ${results.succeeded.length} succeeded, ${results.failed.length} failed`,
      metadata: {
        totalItems: items.length,
        succeededItems: results.succeeded.length,
        failedItems: results.failed.length,
        failedItemDetails: results.failed,
      },
    });

    return results;
  } catch (error) {
    await userEventService.updateEvent(userEvent.id, {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      metadata: {
        totalItems: items.length,
        succeededItems: results.succeeded.length,
        failedItems: results.failed.length,
        partialResults: results,
      },
    });
    throw error;
  }
}
```

---

## Metadata Best Practices

### What to Include in Metadata

**DO include**:
- Operation configuration (params, settings)
- Resource identifiers (IDs, names)
- Key metrics (counts, sizes, durations)
- Step information (current step, completed steps)
- Retry information (attempt number, max retries)
- Results summary (items processed, success/failure counts)

**DON'T include**:
- Sensitive data (passwords, API keys, tokens)
- Personal information (emails, phone numbers)
- Very large data (> 1MB JSON)
- Binary data
- Duplicate information already in other fields

### Metadata Structure Examples

#### Deployment Metadata
```typescript
{
  applicationName: 'my-app',
  dockerImage: 'my-app:v1.2.3',
  environmentName: 'production',
  deploymentId: 'dep_abc123',
  configurationId: 'cfg_xyz789',
  triggerType: 'manual',
  steps: [
    { name: 'pull_image', status: 'completed', duration: 5234 },
    { name: 'create_container', status: 'completed', duration: 1523 },
    { name: 'health_check', status: 'running', duration: null },
  ],
}
```

#### Backup Metadata
```typescript
{
  databaseName: 'production-db',
  databaseHost: 'db.example.com',
  backupType: 'full',
  compressionLevel: 6,
  sizeBytes: 1073741824, // 1GB
  azureBlobUrl: 'https://storage.blob.core.windows.net/...',
  duration: 45000, // 45 seconds
  triggeredBy: 'scheduled',
}
```

#### Certificate Metadata
```typescript
{
  domains: ['example.com', '*.example.com'],
  primaryDomain: 'example.com',
  certificateType: 'ACME',
  acmeProvider: 'letsencrypt',
  challengeType: 'dns-01',
  expiresAt: '2025-03-01T00:00:00Z',
  renewAfter: '2025-02-01T00:00:00Z',
}
```

#### Container Cleanup Metadata
```typescript
{
  containersIdentified: 15,
  containersRemoved: 12,
  containersFailed: 3,
  ageThresholdHours: 24,
  dryRun: false,
  removedContainerIds: ['abc123', 'def456', ...],
  failedContainerIds: ['ghi789'],
}
```

---

## Progress Tracking

### Progress Guidelines

**Progress values**:
- Use integers from 0-100 (percentage)
- Start at 0 when created (default)
- Update at meaningful milestones
- End at 100 when completed

**When to update progress**:
- After completing distinct steps
- After processing batches of items
- At regular intervals for very long operations (every 5-10%)
- NOT on every iteration of a tight loop

### Progress Calculation Examples

#### Fixed Steps
```typescript
const totalSteps = 4;
let currentStep = 0;

// Step 1
await doStep1();
currentStep++;
await updateEvent(eventId, { progress: Math.floor((currentStep / totalSteps) * 100) }); // 25%

// Step 2
await doStep2();
currentStep++;
await updateEvent(eventId, { progress: Math.floor((currentStep / totalSteps) * 100) }); // 50%

// And so on...
```

#### Variable Steps (Weighted)
```typescript
const steps = [
  { name: 'pull_image', weight: 30 },      // Takes longer
  { name: 'create_container', weight: 10 }, // Quick
  { name: 'health_check', weight: 50 },    // Takes longest
  { name: 'switch_traffic', weight: 10 },  // Quick
];

let completedWeight = 0;
const totalWeight = steps.reduce((sum, step) => sum + step.weight, 0);

for (const step of steps) {
  await doStep(step.name);
  completedWeight += step.weight;
  const progress = Math.floor((completedWeight / totalWeight) * 100);
  await updateEvent(eventId, { progress });
}
```

#### Item Processing
```typescript
const items = [...]; // 100 items
for (let i = 0; i < items.length; i++) {
  await processItem(items[i]);

  // Update every 10 items to avoid too many DB calls
  if ((i + 1) % 10 === 0 || i === items.length - 1) {
    const progress = Math.floor(((i + 1) / items.length) * 100);
    await updateEvent(eventId, { progress });
  }
}
```

---

## Log Management

### When to Append Logs

**DO append logs for**:
- Step completions
- Important state changes
- Errors and warnings
- Retry attempts
- Key metrics or results

**DON'T append logs for**:
- Every function call
- Verbose debug information
- High-frequency events
- Information already in metadata

### Log Format Guidelines

**Good log format**:
```typescript
await appendLogs(eventId, `[${new Date().toISOString()}] Step completed: pulling image (5.2s)`);
await appendLogs(eventId, `[${new Date().toISOString()}] Health check passed on attempt 1`);
await appendLogs(eventId, `[${new Date().toISOString()}] ERROR: Connection timeout to database`);
```

**Structured logs** (for complex data):
```typescript
await appendLogs(eventId, JSON.stringify({
  timestamp: new Date().toISOString(),
  step: 'health_check',
  status: 'passed',
  duration: 1234,
  endpoint: '/health',
  statusCode: 200,
}, null, 2));
```

### Log Size Considerations

- SQLite has no hard limit, but keep logs reasonable (< 10MB per event)
- For very verbose operations, consider summarizing logs
- Store full details in metadata, summary in logs

---

## Error Handling

### Error Handling Pattern

```typescript
try {
  // ... operation code ...
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  const errorStack = error instanceof Error ? error.stack : undefined;

  await userEventService.updateEvent(userEvent.id, {
    status: 'failed',
    errorMessage,
    errorDetails: {
      type: error instanceof Error ? error.constructor.name : 'Unknown',
      message: errorMessage,
      stack: errorStack,
      context: {
        // Add operation-specific context
        step: currentStep,
        attemptNumber,
        params,
      },
    },
  });

  // Re-throw to propagate error
  throw error;
}
```

### Partial Success Handling

For batch operations where some items succeed and others fail:

```typescript
const hasFailures = results.failed.length > 0;
const allFailed = results.failed.length === items.length;

await userEventService.updateEvent(userEvent.id, {
  status: allFailed ? 'failed' : 'completed',
  resultSummary: hasFailures
    ? `Completed with ${results.failed.length} failures out of ${items.length} items`
    : `Successfully processed all ${items.length} items`,
  errorMessage: hasFailures
    ? `${results.failed.length} items failed to process`
    : undefined,
  errorDetails: hasFailures
    ? { failedItems: results.failed }
    : undefined,
});
```

### Timeout Handling

```typescript
try {
  const result = await Promise.race([
    performOperation(),
    timeout(30000), // 30 second timeout
  ]);

  await userEventService.updateEvent(userEvent.id, {
    status: 'completed',
    resultSummary: 'Operation completed successfully',
  });
} catch (error) {
  if (error instanceof TimeoutError) {
    await userEventService.updateEvent(userEvent.id, {
      status: 'failed',
      errorMessage: 'Operation timed out after 30 seconds',
      errorDetails: {
        type: 'TimeoutError',
        timeoutMs: 30000,
      },
    });
  } else {
    // Handle other errors
  }
  throw error;
}
```

---

## Testing Instrumented Code

### Unit Testing

Mock the UserEventService to test your logic without database calls:

```typescript
import { UserEventService } from '../services/user-event-service';

jest.mock('../services/user-event-service');

describe('myOperation', () => {
  let mockUserEventService: jest.Mocked<UserEventService>;

  beforeEach(() => {
    mockUserEventService = {
      createEvent: jest.fn().mockResolvedValue({ id: 'event_123' }),
      updateEvent: jest.fn().mockResolvedValue({ id: 'event_123' }),
      appendLogs: jest.fn().mockResolvedValue({ id: 'event_123' }),
    } as any;
  });

  it('should create and complete user event on success', async () => {
    await myOperation('user_123', { param: 'value' });

    expect(mockUserEventService.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'my_operation',
        eventCategory: 'infrastructure',
        userId: 'user_123',
      })
    );

    expect(mockUserEventService.updateEvent).toHaveBeenCalledWith(
      'event_123',
      expect.objectContaining({
        status: 'completed',
      })
    );
  });

  it('should mark event as failed on error', async () => {
    // Make the operation fail
    jest.spyOn(global, 'doWork').mockRejectedValue(new Error('Test error'));

    await expect(myOperation('user_123', {})).rejects.toThrow('Test error');

    expect(mockUserEventService.updateEvent).toHaveBeenCalledWith(
      'event_123',
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Test error',
      })
    );
  });
});
```

### Integration Testing

Test the full flow including database:

```typescript
import { UserEventService } from '../services/user-event-service';
import prisma from '../lib/prisma';

describe('myOperation integration', () => {
  const userEventService = new UserEventService(prisma);

  afterEach(async () => {
    // Clean up test events
    await prisma.userEvent.deleteMany({
      where: { eventName: { startsWith: 'Test:' } },
    });
  });

  it('should create user event in database', async () => {
    await myOperation('user_123', { name: 'test' });

    const events = await prisma.userEvent.findMany({
      where: { eventType: 'my_operation' },
    });

    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('completed');
  });
});
```

---

## Performance Considerations

### Database Calls

**Minimize update frequency**:
```typescript
// ❌ Bad: Update on every iteration
for (const item of items) {
  await processItem(item);
  await updateEvent(eventId, { progress: calculateProgress() }); // Too many DB calls
}

// ✅ Good: Batch updates
for (let i = 0; i < items.length; i++) {
  await processItem(items[i]);

  // Update every 10 items or on last item
  if ((i + 1) % 10 === 0 || i === items.length - 1) {
    await updateEvent(eventId, { progress: calculateProgress() });
  }
}
```

### Log Appending

**Batch log appends**:
```typescript
// ❌ Bad: Append logs individually
await appendLogs(eventId, 'Step 1 done');
await appendLogs(eventId, 'Step 2 done');
await appendLogs(eventId, 'Step 3 done');

// ✅ Good: Collect and append in batches
const logBuffer: string[] = [];
logBuffer.push('Step 1 done');
logBuffer.push('Step 2 done');
logBuffer.push('Step 3 done');
await appendLogs(eventId, logBuffer.join('\n'));
```

### Async/Await

**Don't block operation on event updates**:
```typescript
// ❌ Bad: Wait for every update
await updateEvent(eventId, { progress: 50 });
await doSomething();

// ✅ Better: Fire-and-forget for non-critical updates
updateEvent(eventId, { progress: 50 }).catch(err =>
  logger.error('Failed to update event', err)
);
await doSomething();

// ⚠️ Note: Always await create/complete to ensure data integrity
await createEvent(...); // DO await
// ... operation ...
await updateEvent(eventId, { status: 'completed' }); // DO await
```

### Metadata Size

**Keep metadata reasonable**:
```typescript
// ❌ Bad: Storing huge arrays
metadata: {
  allContainerIds: [...10000 items...], // Too large
}

// ✅ Good: Store summary + sample
metadata: {
  totalContainers: 10000,
  sampleContainerIds: containerIds.slice(0, 10),
  fullListAvailable: true,
}
```

---

## Complete Examples

### Example 1: Deployment Operation

```typescript
import { UserEventService } from '../services/user-event-service';
import prisma from '../lib/prisma';
import type { DeploymentEventMetadata } from '@mini-infra/types';

const userEventService = new UserEventService(prisma);

export async function executeDeployment(
  deploymentId: string,
  userId: string,
  config: DeploymentConfig
) {
  const metadata: DeploymentEventMetadata = {
    applicationName: config.applicationName,
    dockerImage: config.dockerImage,
    environmentName: config.environmentName,
    deploymentId,
    configurationId: config.id,
    triggerType: 'manual',
    steps: [],
  };

  const userEvent = await userEventService.createEvent({
    eventType: 'deployment',
    eventCategory: 'infrastructure',
    eventName: `Deploy ${config.applicationName}`,
    userId,
    triggeredBy: 'manual',
    resourceId: deploymentId,
    resourceType: 'deployment',
    resourceName: config.applicationName,
    description: `Deploying ${config.dockerImage}`,
    metadata,
  });

  try {
    // Step 1: Pull image (0-25%)
    const pullStart = Date.now();
    await appendLogs(userEvent.id, `[1/4] Pulling image: ${config.dockerImage}`);
    await pullDockerImage(config.dockerImage);
    metadata.steps.push({
      name: 'pull_image',
      status: 'completed',
      startedAt: new Date(pullStart).toISOString(),
      completedAt: new Date().toISOString(),
      duration: Date.now() - pullStart,
    });
    await updateEvent(userEvent.id, { progress: 25, metadata });

    // Step 2: Create container (25-50%)
    const createStart = Date.now();
    await appendLogs(userEvent.id, `[2/4] Creating container`);
    const container = await createContainer(config);
    metadata.steps.push({
      name: 'create_container',
      status: 'completed',
      startedAt: new Date(createStart).toISOString(),
      completedAt: new Date().toISOString(),
      duration: Date.now() - createStart,
    });
    await updateEvent(userEvent.id, { progress: 50, metadata });

    // Step 3: Health check (50-80%)
    const healthStart = Date.now();
    await appendLogs(userEvent.id, `[3/4] Running health checks`);
    await performHealthCheck(container.id, config.healthCheckConfig);
    metadata.steps.push({
      name: 'health_check',
      status: 'completed',
      startedAt: new Date(healthStart).toISOString(),
      completedAt: new Date().toISOString(),
      duration: Date.now() - healthStart,
    });
    await updateEvent(userEvent.id, { progress: 80, metadata });

    // Step 4: Switch traffic (80-100%)
    const switchStart = Date.now();
    await appendLogs(userEvent.id, `[4/4] Switching traffic to new container`);
    await switchTraffic(config.applicationName, container.id);
    metadata.steps.push({
      name: 'switch_traffic',
      status: 'completed',
      startedAt: new Date(switchStart).toISOString(),
      completedAt: new Date().toISOString(),
      duration: Date.now() - switchStart,
    });

    // Complete
    await userEventService.updateEvent(userEvent.id, {
      status: 'completed',
      progress: 100,
      resultSummary: `Successfully deployed ${config.applicationName}`,
      metadata,
    });

    return { success: true, containerId: container.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await userEventService.updateEvent(userEvent.id, {
      status: 'failed',
      errorMessage: `Deployment failed: ${errorMessage}`,
      errorDetails: {
        type: error instanceof Error ? error.constructor.name : 'Unknown',
        message: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        config: {
          applicationName: config.applicationName,
          dockerImage: config.dockerImage,
        },
        steps: metadata.steps,
      },
      metadata,
    });

    throw error;
  }
}
```

### Example 2: Certificate Renewal

```typescript
import { UserEventService } from '../services/user-event-service';
import prisma from '../lib/prisma';
import type { CertificateEventMetadata } from '@mini-infra/types';

const userEventService = new UserEventService(prisma);

export async function renewCertificate(
  certificateId: string,
  userId: string | undefined,
  isAutoRenewal: boolean
) {
  const certificate = await getCertificate(certificateId);

  const metadata: CertificateEventMetadata = {
    domains: certificate.domains,
    primaryDomain: certificate.primaryDomain,
    certificateType: certificate.certificateType,
    acmeProvider: certificate.acmeProvider,
  };

  const userEvent = await userEventService.createEvent({
    eventType: 'certificate_renew',
    eventCategory: 'security',
    eventName: `Renew Certificate: ${certificate.primaryDomain}`,
    userId,
    triggeredBy: isAutoRenewal ? 'scheduled' : 'manual',
    resourceId: certificateId,
    resourceType: 'certificate',
    resourceName: certificate.primaryDomain,
    description: `Renewing TLS certificate for ${certificate.domains.join(', ')}`,
    metadata,
  });

  try {
    // Step 1: Create ACME order
    await appendLogs(userEvent.id, '[1/5] Creating ACME order...');
    const order = await createAcmeOrder(certificate.domains);
    await updateEvent(userEvent.id, { progress: 20 });

    // Step 2: Create DNS challenges
    await appendLogs(userEvent.id, '[2/5] Creating DNS challenges...');
    const challenges = await createDnsChallenges(order);
    await updateEvent(userEvent.id, { progress: 40 });

    // Step 3: Wait for DNS propagation and validate
    await appendLogs(userEvent.id, '[3/5] Waiting for DNS propagation...');
    await waitForDnsPropagation(challenges);
    await appendLogs(userEvent.id, '[3/5] Validating challenges...');
    await validateChallenges(order);
    await updateEvent(userEvent.id, { progress: 60 });

    // Step 4: Download certificate
    await appendLogs(userEvent.id, '[4/5] Downloading certificate...');
    const newCertificate = await downloadCertificate(order);
    await updateEvent(userEvent.id, { progress: 80 });

    // Step 5: Deploy to HAProxy
    await appendLogs(userEvent.id, '[5/5] Deploying to HAProxy...');
    await deployToHaproxy(newCertificate);

    // Complete
    await userEventService.updateEvent(userEvent.id, {
      status: 'completed',
      progress: 100,
      resultSummary: `Certificate renewed successfully. Valid until ${newCertificate.notAfter}`,
      metadata: {
        ...metadata,
        expiresAt: newCertificate.notAfter,
      },
    });

    return { success: true, certificate: newCertificate };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await userEventService.updateEvent(userEvent.id, {
      status: 'failed',
      errorMessage: `Certificate renewal failed: ${errorMessage}`,
      errorDetails: {
        type: error instanceof Error ? error.constructor.name : 'Unknown',
        message: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        certificate: {
          domains: certificate.domains,
          primaryDomain: certificate.primaryDomain,
        },
      },
      metadata,
    });

    throw error;
  }
}
```

---

## Checklist for Instrumentation

When adding User Events to a new operation, use this checklist:

- [ ] Choose appropriate event type
- [ ] Choose appropriate event category
- [ ] Create descriptive event name
- [ ] Create event at start of operation
- [ ] Set userId if user-initiated
- [ ] Set correct triggeredBy value
- [ ] Add resourceId/resourceType if applicable
- [ ] Include relevant metadata
- [ ] Update progress at meaningful milestones
- [ ] Append logs at key steps
- [ ] Handle success case (status: 'completed')
- [ ] Handle failure case (status: 'failed' with error details)
- [ ] Calculate and set duration on completion
- [ ] Add try/catch block around operation
- [ ] Add tests for instrumented code
- [ ] Update documentation if adding new event type

---

## Questions or Issues?

If you have questions about instrumenting a specific operation or run into issues, please:
1. Review the examples in this guide
2. Check existing instrumented operations in the codebase
3. Refer to the User Events Remaining Work document for integration examples
4. Update this guide with new patterns you discover!
