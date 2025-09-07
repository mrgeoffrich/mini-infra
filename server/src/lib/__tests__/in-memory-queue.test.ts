import { jest } from "@jest/globals";
import { InMemoryQueue, Job, JobOptions, QueueOptions } from "../in-memory-queue";

// Helper function to wait for a specific duration
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to wait for a condition with timeout
const waitFor = async (condition: () => boolean, timeout = 5000, interval = 10): Promise<void> => {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeout) {
    await wait(interval);
  }
  if (!condition()) {
    throw new Error(`Condition not met within ${timeout}ms`);
  }
};

describe('InMemoryQueue', () => {
  let queue: InMemoryQueue;

  afterEach(async () => {
    if (queue) {
      await queue.close();
    }
  });

  describe('Basic Operations', () => {
    test('should create a queue with default options', () => {
      queue = new InMemoryQueue('test-queue');
      expect(queue).toBeInstanceOf(InMemoryQueue);
      expect(queue.getStats().total).toBe(0);
    });

    test('should create a queue with custom options', () => {
      const options: QueueOptions = {
        concurrency: 5,
        defaultJobOptions: {
          attempts: 2,
          removeOnComplete: 20,
          removeOnFail: 30,
        },
      };
      queue = new InMemoryQueue('test-queue', options);
      expect(queue).toBeInstanceOf(InMemoryQueue);
    });

    test('should add and process a job successfully', async () => {
      queue = new InMemoryQueue('test-queue');
      
      let processedJob: Job | null = null;
      let processedData: any = null;
      
      queue.process('test-job', async (job: Job) => {
        processedJob = job;
        processedData = job.data;
        return 'success';
      });

      const job = await queue.add('test-job', { message: 'hello' });
      
      expect(job.name).toBe('test-job');
      expect(job.data).toEqual({ message: 'hello' });
      expect(job.status).toBe('pending');

      await waitFor(() => processedJob !== null);
      
      expect(processedJob).toBeTruthy();
      expect(processedData).toEqual({ message: 'hello' });
    });

    test('should handle job completion events', async () => {
      queue = new InMemoryQueue('test-queue');
      
      const completedJobs: Job[] = [];
      const completedResults: any[] = [];
      
      queue.on('completed', (job: Job, result: any) => {
        completedJobs.push(job);
        completedResults.push(result);
      });

      queue.process('test-job', async () => 'test-result');
      
      await queue.add('test-job', { test: true });
      
      await waitFor(() => completedJobs.length > 0);
      
      expect(completedJobs).toHaveLength(1);
      expect(completedResults[0]).toBe('test-result');
      expect(completedJobs[0].status).toBe('completed');
    });

    test('should maintain job data integrity', async () => {
      queue = new InMemoryQueue('test-queue');
      
      const testData = {
        id: 123,
        name: 'test',
        nested: { value: 'deep' },
        array: [1, 2, 3],
      };
      
      let receivedData: any = null;
      
      queue.process('test-job', async (job: Job) => {
        receivedData = job.data;
        return 'done';
      });
      
      await queue.add('test-job', testData);
      
      await waitFor(() => receivedData !== null);
      
      expect(receivedData).toEqual(testData);
      // Data should be deep copied, not the same reference
      expect(receivedData !== testData).toBe(true);
    });
  });

  describe('Concurrency', () => {
    test('should process jobs sequentially with concurrency=1', async () => {
      queue = new InMemoryQueue('test-queue', { concurrency: 1 });
      
      const processOrder: number[] = [];
      const startTimes: number[] = [];
      const endTimes: number[] = [];
      
      queue.process('test-job', async (job: Job) => {
        const jobNum = job.data.num;
        startTimes[jobNum] = Date.now();
        processOrder.push(jobNum);
        
        await wait(50); // Simulate work
        
        endTimes[jobNum] = Date.now();
        return `result-${jobNum}`;
      });
      
      // Add 3 jobs
      await Promise.all([
        queue.add('test-job', { num: 1 }),
        queue.add('test-job', { num: 2 }),
        queue.add('test-job', { num: 3 }),
      ]);
      
      await waitFor(() => processOrder.length === 3);
      
      expect(processOrder).toEqual([1, 2, 3]);
      
      // Verify jobs ran sequentially (no overlap)
      expect(endTimes[1]).toBeLessThanOrEqual(startTimes[2]);
      expect(endTimes[2]).toBeLessThanOrEqual(startTimes[3]);
    });

    test('should process multiple jobs concurrently', async () => {
      queue = new InMemoryQueue('test-queue', { concurrency: 3 });
      
      const processOrder: number[] = [];
      const startTimes: number[] = [];
      
      queue.process('test-job', async (job: Job) => {
        const jobNum = job.data.num;
        startTimes[jobNum] = Date.now();
        processOrder.push(jobNum);
        
        await wait(100); // Simulate work
        
        return `result-${jobNum}`;
      });
      
      const startTime = Date.now();
      
      // Add 5 jobs
      await Promise.all([
        queue.add('test-job', { num: 1 }),
        queue.add('test-job', { num: 2 }),
        queue.add('test-job', { num: 3 }),
        queue.add('test-job', { num: 4 }),
        queue.add('test-job', { num: 5 }),
      ]);
      
      await waitFor(() => processOrder.length === 5);
      
      const totalTime = Date.now() - startTime;
      
      // With concurrency=3, 5 jobs should complete faster than sequential
      expect(totalTime).toBeLessThan(400); // Should be ~200ms, not 500ms
      
      // First 3 jobs should start almost simultaneously
      const firstThreeStartTimes = [startTimes[1], startTimes[2], startTimes[3]];
      const maxStartTimeDiff = Math.max(...firstThreeStartTimes) - Math.min(...firstThreeStartTimes);
      expect(maxStartTimeDiff).toBeLessThan(50);
    });

    test('should not exceed concurrency limit', async () => {
      queue = new InMemoryQueue('test-queue', { concurrency: 2 });
      
      let activeJobs = 0;
      let maxActiveJobs = 0;
      
      queue.process('test-job', async (job: Job) => {
        activeJobs++;
        maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
        
        await wait(100);
        
        activeJobs--;
        return `done-${job.data.num}`;
      });
      
      // Add 5 jobs sequentially to ensure they are processed
      const jobs = [];
      for (let i = 1; i <= 5; i++) {
        jobs.push(await queue.add('test-job', { num: i }));
      }
      
      // Wait for all jobs to complete
      await waitFor(() => {
        const stats = queue.getStats();
        return stats.completed >= 5 && stats.active === 0;
      });
      
      expect(maxActiveJobs).toBeLessThanOrEqual(2);
      expect(maxActiveJobs).toBeGreaterThan(0);
    });

    test('should maintain FIFO order within concurrency limits', async () => {
      queue = new InMemoryQueue('test-queue', { concurrency: 2 });
      
      const processOrder: number[] = [];
      
      queue.process('test-job', async (job: Job) => {
        processOrder.push(job.data.num);
        await wait(50);
        return 'done';
      });
      
      // Add jobs sequentially
      for (let i = 1; i <= 6; i++) {
        await queue.add('test-job', { num: i });
      }
      
      await waitFor(() => processOrder.length === 6);
      
      // First 2 should start immediately (in order)
      expect(processOrder.slice(0, 2)).toEqual([1, 2]);
      
      // Remaining should follow FIFO order
      expect(processOrder).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe('Retry Logic', () => {
    test('should retry failed jobs', async () => {
      queue = new InMemoryQueue('test-queue', {
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'fixed', delay: 10 },
        },
      });
      
      let attemptCount = 0;
      const attempts: number[] = [];
      
      queue.process('test-job', async (job: Job) => {
        attemptCount++;
        attempts.push(job.attempts);
        
        if (attemptCount < 3) {
          throw new Error(`Attempt ${attemptCount} failed`);
        }
        
        return 'success';
      });
      
      await queue.add('test-job', { test: true });
      
      await waitFor(() => attemptCount === 3);
      
      expect(attempts).toEqual([1, 2, 3]);
    });

    test('should apply exponential backoff', async () => {
      queue = new InMemoryQueue('test-queue', {
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 50 },
        },
      });
      
      const attemptTimes: number[] = [];
      let attemptCount = 0;
      
      queue.process('test-job', async () => {
        attemptTimes.push(Date.now());
        attemptCount++;
        
        if (attemptCount < 3) {
          throw new Error(`Attempt ${attemptCount} failed`);
        }
        
        return 'success';
      });
      
      await queue.add('test-job', { test: true });
      
      await waitFor(() => attemptCount === 3, 10000);
      
      expect(attemptTimes).toHaveLength(3);
      
      // Check that delays are increasing (exponential backoff)
      const delay1 = attemptTimes[1] - attemptTimes[0];
      const delay2 = attemptTimes[2] - attemptTimes[1];
      
      expect(delay1).toBeGreaterThanOrEqual(40); // ~50ms with jitter
      expect(delay2).toBeGreaterThanOrEqual(80); // ~100ms with jitter
      expect(delay2).toBeGreaterThan(delay1);
    });

    test('should respect max attempts', async () => {
      queue = new InMemoryQueue('test-queue', {
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'fixed', delay: 10 },
        },
      });
      
      let attemptCount = 0;
      const failedJobs: Job[] = [];
      
      queue.on('failed', (job: Job) => {
        failedJobs.push(job);
      });
      
      queue.process('test-job', async () => {
        attemptCount++;
        throw new Error(`Attempt ${attemptCount} failed`);
      });
      
      await queue.add('test-job', { test: true });
      
      await waitFor(() => failedJobs.length > 0);
      
      expect(attemptCount).toBe(2);
      expect(failedJobs).toHaveLength(1);
      expect(failedJobs[0].status).toBe('failed');
      expect(failedJobs[0].attempts).toBe(2);
    });

    test('should emit failed event after max attempts', async () => {
      queue = new InMemoryQueue('test-queue', {
        defaultJobOptions: { 
          attempts: 1,  // Only 1 attempt to make test faster
          backoff: { type: 'fixed', delay: 10 }
        },
      });
      
      const failedJobs: Job[] = [];
      const failedErrors: Error[] = [];
      let processCount = 0;
      
      queue.on('failed', (job: Job, error: Error) => {
        failedJobs.push(job);
        failedErrors.push(error);
      });
      
      queue.process('test-job', async () => {
        processCount++;
        throw new Error('Always fails');
      });
      
      await queue.add('test-job', { test: true });
      
      await waitFor(() => failedJobs.length > 0, 5000);
      
      expect(processCount).toBe(1); // Should only try once
      expect(failedJobs).toHaveLength(1);
      expect(failedErrors).toHaveLength(1);
      expect(failedErrors[0].message).toBe('Always fails');
    }, 10000);
  });

  describe('Event System', () => {
    test('should emit completed event with job and result', async () => {
      queue = new InMemoryQueue('test-queue');
      
      const completedEvents: Array<{ job: Job; result: any }> = [];
      
      queue.on('completed', (job: Job, result: any) => {
        completedEvents.push({ job, result });
      });
      
      queue.process('test-job', async () => ({ success: true, data: 123 }));
      
      await queue.add('test-job', { input: 'test' });
      
      await waitFor(() => completedEvents.length > 0);
      
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0].job.data).toEqual({ input: 'test' });
      expect(completedEvents[0].result).toEqual({ success: true, data: 123 });
    });

    test('should emit failed event with job and error', async () => {
      queue = new InMemoryQueue('test-queue', {
        defaultJobOptions: { attempts: 1 },
      });
      
      const failedEvents: Array<{ job: Job; error: Error }> = [];
      
      queue.on('failed', (job: Job, error: Error) => {
        failedEvents.push({ job, error });
      });
      
      queue.process('test-job', async () => {
        throw new Error('Test error');
      });
      
      await queue.add('test-job', { input: 'test' });
      
      await waitFor(() => failedEvents.length > 0);
      
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].job.data).toEqual({ input: 'test' });
      expect(failedEvents[0].error.message).toBe('Test error');
    });

    test('should handle multiple event listeners', async () => {
      queue = new InMemoryQueue('test-queue');
      
      const listener1Results: any[] = [];
      const listener2Results: any[] = [];
      
      queue.on('completed', (job: Job, result: any) => {
        listener1Results.push(result);
      });
      
      queue.on('completed', (job: Job, result: any) => {
        listener2Results.push(result);
      });
      
      queue.process('test-job', async () => 'test-result');
      
      await queue.add('test-job', {});
      
      await waitFor(() => listener1Results.length > 0 && listener2Results.length > 0);
      
      expect(listener1Results).toEqual(['test-result']);
      expect(listener2Results).toEqual(['test-result']);
    });

    test('should emit progress events', async () => {
      queue = new InMemoryQueue('test-queue');
      
      const progressEvents: Array<{ job: Job; progress: number }> = [];
      
      queue.on('progress', (job: Job, progress: number) => {
        progressEvents.push({ job, progress });
      });
      
      queue.process('test-job', async (job: Job) => {
        queue.updateJobProgress(job, 25);
        await wait(10);
        queue.updateJobProgress(job, 75);
        await wait(10);
        return 'done';
      });
      
      await queue.add('test-job', {});
      
      await waitFor(() => progressEvents.length >= 2);
      
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);
      expect(progressEvents.map(e => e.progress)).toEqual(expect.arrayContaining([25, 75]));
    });
  });

  describe('Job Management', () => {
    test('should get jobs by status', async () => {
      queue = new InMemoryQueue('test-queue', { concurrency: 1 });
      
      const completedJobs: Job[] = [];
      
      queue.on('completed', (job: Job) => {
        completedJobs.push(job);
      });
      
      queue.process('test-job', async (job: Job) => {
        await wait(50);
        return `result-${job.data.id}`;
      });
      
      // Add multiple jobs
      await Promise.all([
        queue.add('test-job', { id: 1 }),
        queue.add('test-job', { id: 2 }),
        queue.add('test-job', { id: 3 }),
      ]);
      
      // Check initial state
      const allJobs = await queue.getJobs();
      expect(allJobs).toHaveLength(3);
      
      const pendingJobs = await queue.getJobs(['pending']);
      expect(pendingJobs.length).toBeGreaterThan(0);
      
      // Wait for some completion
      await waitFor(() => completedJobs.length > 0);
      
      const completedJobsFromQueue = await queue.getJobs(['completed']);
      expect(completedJobsFromQueue.length).toBeGreaterThan(0);
    });

    test('should remove pending jobs', async () => {
      queue = new InMemoryQueue('test-queue', { concurrency: 1 });
      
      queue.process('test-job', async () => {
        await wait(100); // Long running to keep first job active
        return 'done';
      });
      
      const job1 = await queue.add('test-job', { id: 1 });
      const job2 = await queue.add('test-job', { id: 2 });
      const job3 = await queue.add('test-job', { id: 3 });
      
      // Wait for first job to become active
      await wait(10);
      
      // Try to remove active job (should fail)
      await expect(queue.remove(job1.id)).rejects.toThrow('Cannot remove active job');
      
      // Remove pending jobs
      await queue.remove(job2.id);
      await queue.remove(job3.id);
      
      const remainingJobs = await queue.getJobs(['pending']);
      expect(remainingJobs).toHaveLength(0);
    });

    test('should maintain job history limits', async () => {
      queue = new InMemoryQueue('test-queue', {
        defaultJobOptions: {
          attempts: 1, // No retries to make test faster
          removeOnComplete: 2,
          removeOnFail: 2,
        },
      });
      
      let successCount = 0;
      let failCount = 0;
      
      queue.process('success-job', async () => {
        successCount++;
        return 'success';
      });
      
      queue.process('fail-job', async () => {
        failCount++;
        throw new Error('fail');
      });
      
      // Add more jobs than the limit
      for (let i = 1; i <= 3; i++) {
        await queue.add('success-job', { id: i });
      }
      
      for (let i = 1; i <= 3; i++) {
        await queue.add('fail-job', { id: i });
      }
      
      await waitFor(() => {
        return successCount >= 3 && failCount >= 3;
      }, 5000);
      
      const completedJobs = await queue.getJobs(['completed']);
      const failedJobs = await queue.getJobs(['failed']);
      
      expect(completedJobs.length).toBeLessThanOrEqual(2);
      expect(failedJobs.length).toBeLessThanOrEqual(2);
    }, 10000);

    test('should handle queue closure gracefully', async () => {
      queue = new InMemoryQueue('test-queue');
      
      let processingStarted = false;
      
      queue.process('test-job', async () => {
        processingStarted = true;
        await wait(100);
        return 'done';
      });
      
      await queue.add('test-job', {});
      
      await waitFor(() => processingStarted);
      
      const closePromise = queue.close();
      
      // Should wait for active job to complete
      await expect(closePromise).resolves.toBeUndefined();
      
      const stats = queue.getStats();
      expect(stats.total).toBe(0);
      
      // Should not accept new jobs
      await expect(queue.add('test-job', {})).rejects.toThrow('Queue is closed');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty queue processing', () => {
      queue = new InMemoryQueue('test-queue');
      
      queue.process('test-job', async () => 'done');
      
      const stats = queue.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.total).toBe(0);
    });

    test('should handle rapid job addition', async () => {
      queue = new InMemoryQueue('test-queue', { concurrency: 2 });
      
      const processedJobs: number[] = [];
      
      queue.process('test-job', async (job: Job) => {
        processedJobs.push(job.data.id);
        await wait(10);
        return 'done';
      });
      
      // Add jobs rapidly
      const jobs = [];
      for (let i = 1; i <= 20; i++) {
        jobs.push(queue.add('test-job', { id: i }));
      }
      
      await Promise.all(jobs);
      
      await waitFor(() => processedJobs.length === 20);
      
      expect(processedJobs).toHaveLength(20);
      expect(new Set(processedJobs).size).toBe(20); // All unique
    });

    test('should handle processor errors gracefully', async () => {
      queue = new InMemoryQueue('test-queue', {
        defaultJobOptions: { attempts: 1 }
      });
      
      const failedJobs: Job[] = [];
      const completedJobs: Job[] = [];
      
      queue.on('failed', (job: Job) => {
        failedJobs.push(job);
      });

      queue.on('completed', (job: Job) => {
        completedJobs.push(job);
      });
      
      // Processor throws error
      queue.process('error-job', async () => {
        throw new Error('Processor error');
      });
      
      // Processor returns undefined (this should succeed)
      queue.process('undefined-job', async () => {
        return undefined;
      });
      
      await queue.add('error-job', {});
      await queue.add('undefined-job', {});
      
      await waitFor(() => failedJobs.length > 0 && completedJobs.length > 0, 10000);
      
      expect(failedJobs).toHaveLength(1);
      expect(completedJobs).toHaveLength(1);
    }, 15000);

    test('should handle missing processor', async () => {
      queue = new InMemoryQueue('test-queue');
      
      const failedJobs: Job[] = [];
      
      queue.on('failed', (job: Job, error: Error) => {
        failedJobs.push(job);
      });
      
      await queue.add('missing-processor-job', {});
      
      await waitFor(() => failedJobs.length > 0);
      
      expect(failedJobs).toHaveLength(1);
      expect(failedJobs[0].failedReason).toContain('No processor found');
    });

    test('should handle job priority ordering', async () => {
      queue = new InMemoryQueue('test-queue', { concurrency: 1 });
      
      const processOrder: number[] = [];
      
      queue.process('test-job', async (job: Job) => {
        processOrder.push(job.data.priority);
        await wait(10);
        return 'done';
      });
      
      // Add jobs with different priorities
      await queue.add('test-job', { priority: 1 }, { priority: 1 });
      await queue.add('test-job', { priority: 5 }, { priority: 5 });
      await queue.add('test-job', { priority: 3 }, { priority: 3 });
      await queue.add('test-job', { priority: 10 }, { priority: 10 });
      
      await waitFor(() => processOrder.length === 4);
      
      // Should process in priority order (highest first)
      expect(processOrder).toEqual([10, 5, 3, 1]);
    });

    test('should handle delayed jobs', async () => {
      queue = new InMemoryQueue('test-queue');
      
      const processOrder: string[] = [];
      const startTime = Date.now();
      
      queue.process('test-job', async (job: Job) => {
        processOrder.push(job.data.name);
        return 'done';
      });
      
      // Add immediate job
      await queue.add('test-job', { name: 'immediate' });
      
      // Add delayed job
      await queue.add('test-job', { name: 'delayed' }, { delay: 100 });
      
      await waitFor(() => processOrder.length === 2, 1000);
      
      const totalTime = Date.now() - startTime;
      expect(processOrder).toEqual(['immediate', 'delayed']);
      expect(totalTime).toBeGreaterThanOrEqual(90);
    });
  });

  describe('Statistics', () => {
    test('should provide accurate queue statistics', async () => {
      queue = new InMemoryQueue('test-queue', { concurrency: 2 });
      
      queue.process('test-job', async () => {
        await wait(100);
        return 'done';
      });
      
      // Initial stats
      let stats = queue.getStats();
      expect(stats).toEqual({
        pending: 0,
        active: 0,
        completed: 0,
        failed: 0,
        total: 0,
      });
      
      // Add jobs
      await Promise.all([
        queue.add('test-job', { id: 1 }),
        queue.add('test-job', { id: 2 }),
        queue.add('test-job', { id: 3 }),
        queue.add('test-job', { id: 4 }),
      ]);
      
      stats = queue.getStats();
      expect(stats.total).toBe(4);
      expect(stats.pending).toBeGreaterThan(0);
      
      // Wait for some processing
      await wait(150);
      stats = queue.getStats();
      expect(stats.completed).toBeGreaterThan(0);
      
      // Wait for completion
      await waitFor(() => queue.getStats().active === 0 && queue.getStats().pending === 0);
      
      stats = queue.getStats();
      expect(stats.completed).toBe(4);
      expect(stats.failed).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.pending).toBe(0);
    });
  });
});