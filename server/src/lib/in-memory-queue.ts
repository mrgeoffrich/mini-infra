import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { getLogger } from "./logger-factory";

const logger = getLogger("platform", "in-memory-queue");

/**
 * Job options for individual jobs
 */
export interface JobOptions {
  attempts?: number;
  backoff?: {
    type: "exponential" | "fixed";
    delay: number;
  };
  delay?: number;
  priority?: number;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
}

/**
 * Queue configuration options
 */
export interface QueueOptions {
  concurrency?: number;
  defaultJobOptions?: {
    attempts?: number;
    backoff?: {
      type: "exponential" | "fixed";
      delay: number;
    };
    removeOnComplete?: number;
    removeOnFail?: number;
  };
}

/**
 * Job status enumeration
 */
export type JobStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "stalled";

/**
 * Job interface matching Bull's job structure
 */
export interface Job<TData = unknown, TResult = unknown> {
  id: string;
  name: string;
  data: TData;
  opts: JobOptions;
  attempts: number;
  maxAttempts: number;
  status: JobStatus;
  progress: number;
  returnValue?: TResult;
  failedReason?: string;
  createdAt: Date;
  processedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  delay?: number;
}

/**
 * Processor function type
 */
export type ProcessorFunction<TData = unknown, TResult = unknown> = (
  job: Job<TData, TResult>,
) => Promise<TResult>;

/**
 * In-memory queue implementation compatible with Bull's API
 */
export class InMemoryQueue extends EventEmitter {
  private name: string;
  private options: QueueOptions;
  private pending: Job[] = [];
  private active: Map<string, Job> = new Map();
  private completed: Job[] = [];
  private failed: Job[] = [];
  private processors: Map<string, ProcessorFunction> = new Map();
  private isProcessing = false;
  private isClosed = false;
  private processingTimeouts: Set<NodeJS.Timeout> = new Set();

  constructor(name: string, options: QueueOptions = {}) {
    super();
    this.name = name;
    this.options = {
      concurrency: options.concurrency || 1,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 30000,
        },
        removeOnComplete: 10,
        removeOnFail: 50,
        ...options.defaultJobOptions,
      },
    };
  }

  /**
   * Add a new job to the queue
   */
  async add(name: string, data: unknown, opts: JobOptions = {}): Promise<Job> {
    if (this.isClosed) {
      throw new Error("Queue is closed");
    }

    // Deep clone the data to prevent mutation
    const clonedData = JSON.parse(JSON.stringify(data));

    const job: Job = {
      id: randomUUID(),
      name,
      data: clonedData,
      opts: {
        attempts: opts.attempts ?? this.options.defaultJobOptions!.attempts!,
        backoff: opts.backoff ?? this.options.defaultJobOptions!.backoff!,
        delay: opts.delay,
        priority: opts.priority ?? 0,
        removeOnComplete: opts.removeOnComplete,
        removeOnFail: opts.removeOnFail,
      },
      attempts: 0,
      maxAttempts: opts.attempts ?? this.options.defaultJobOptions!.attempts!,
      status: "pending",
      progress: 0,
      createdAt: new Date(),
    };

    if (job.opts.delay && job.opts.delay > 0) {
      // Delayed job
      const timeout = setTimeout(() => {
        this.processingTimeouts.delete(timeout);
        this.pending.push(job);
        this.processNext();
      }, job.opts.delay);
      this.processingTimeouts.add(timeout);
    } else {
      this.pending.push(job);
      // Sort by priority (higher priority first)
      this.pending.sort(
        (a, b) => (b.opts.priority || 0) - (a.opts.priority || 0),
      );
      setImmediate(() => this.processNext());
    }

    return job;
  }

  /**
   * Register a processor for jobs
   */
  process<TData = unknown, TResult = unknown>(
    name: string,
    concurrencyOrProcessor: number | ProcessorFunction<TData, TResult>,
    processor?: ProcessorFunction<TData, TResult>,
  ): void {
    if (typeof concurrencyOrProcessor === "function") {
      this.processors.set(name, concurrencyOrProcessor as ProcessorFunction);
    } else if (processor) {
      this.processors.set(name, processor as ProcessorFunction);
    } else {
      throw new Error("Processor function is required");
    }

    setImmediate(() => this.processNext());
  }

  /**
   * Get jobs by status
   */
  async getJobs<TData = unknown>(states: string[] = []): Promise<Job<TData>[]> {
    const allJobs: Job[] = [];

    if (states.length === 0 || states.includes("pending")) {
      allJobs.push(...this.pending);
    }
    if (states.length === 0 || states.includes("active")) {
      allJobs.push(...Array.from(this.active.values()));
    }
    if (states.length === 0 || states.includes("completed")) {
      allJobs.push(...this.completed);
    }
    if (states.length === 0 || states.includes("failed")) {
      allJobs.push(...this.failed);
    }

    return allJobs as Job<TData>[];
  }

  /**
   * Get a specific job by ID
   */
  async getJob(jobId: string): Promise<Job | undefined> {
    const allJobs = await this.getJobs();
    return allJobs.find((job) => job.id === jobId);
  }

  /**
   * Remove a job from the queue
   */
  async remove(jobId: string): Promise<void> {
    // Remove from pending
    const pendingIndex = this.pending.findIndex((job) => job.id === jobId);
    if (pendingIndex !== -1) {
      this.pending.splice(pendingIndex, 1);
      return;
    }

    // Cannot remove active jobs
    if (this.active.has(jobId)) {
      throw new Error("Cannot remove active job");
    }

    // Remove from completed
    const completedIndex = this.completed.findIndex((job) => job.id === jobId);
    if (completedIndex !== -1) {
      this.completed.splice(completedIndex, 1);
      return;
    }

    // Remove from failed
    const failedIndex = this.failed.findIndex((job) => job.id === jobId);
    if (failedIndex !== -1) {
      this.failed.splice(failedIndex, 1);
      return;
    }

    throw new Error("Job not found");
  }

  /**
   * Close the queue and cleanup resources
   */
  async close(): Promise<void> {
    this.isClosed = true;

    // Clear all pending timeouts
    this.processingTimeouts.forEach((timeout) => {
      clearTimeout(timeout);
    });
    this.processingTimeouts.clear();

    // Wait for active jobs to complete (with timeout)
    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();

    while (this.active.size > 0 && Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Clear all data
    this.pending = [];
    this.active.clear();
    this.completed = [];
    this.failed = [];
    this.processors.clear();

    this.removeAllListeners();
  }

  /**
   * Process the next available jobs
   */
  private processNext(): void {
    if (this.isClosed) {
      return;
    }

    const concurrency = this.options.concurrency!;

    while (this.pending.length > 0 && this.active.size < concurrency) {
      const job = this.pending.shift()!;
      this.active.set(job.id, job);

      // Process job asynchronously without blocking
      setImmediate(() => {
        this.executeJob(job).catch((err) => {
          logger.error({ err, jobId: job.id }, "Unexpected error in executeJob");
        });
      });
    }
  }

  /**
   * Execute a single job
   */
  private async executeJob(job: Job): Promise<void> {
    const processor = this.processors.get(job.name);
    if (!processor) {
      this.moveJobToFailed(
        job,
        new Error(`No processor found for job type: ${job.name}`),
      );
      return;
    }

    job.status = "active";
    job.attempts++;
    job.processedAt = new Date();

    try {
      const result = await processor(job);
      this.moveJobToCompleted(job, result);
    } catch (error) {
      if (job.attempts < job.maxAttempts) {
        // Retry the job
        this.retryJob(job, error as Error);
      } else {
        // Job failed permanently
        this.moveJobToFailed(job, error as Error);
      }
    }
  }

  /**
   * Retry a failed job with backoff
   */
  private async retryJob(job: Job, error: Error): Promise<void> {
    job.status = "pending";
    job.failedReason = error.message;
    this.active.delete(job.id);

    const delay = this.calculateBackoff(job.attempts, job.opts.backoff!);

    if (delay > 0) {
      const timeout = setTimeout(() => {
        this.processingTimeouts.delete(timeout);
        this.pending.unshift(job); // Add to front for retry
        this.processNext();
      }, delay);
      this.processingTimeouts.add(timeout);
    } else {
      this.pending.unshift(job); // Add to front for retry
      setImmediate(() => this.processNext());
    }
  }

  /**
   * Move job to completed state
   */
  private moveJobToCompleted(job: Job, result: unknown): void {
    job.status = "completed";
    job.completedAt = new Date();
    job.returnValue = result;
    job.progress = 100;

    this.active.delete(job.id);
    this.completed.push(job);

    this.maintainHistory("completed");
    this.emit("completed", job, result);

    // Continue processing
    setImmediate(() => this.processNext());
  }

  /**
   * Move job to failed state
   */
  private moveJobToFailed(job: Job, error: Error): void {
    job.status = "failed";
    job.failedAt = new Date();
    job.failedReason = error.message;

    this.active.delete(job.id);
    this.failed.push(job);

    this.maintainHistory("failed");
    this.emit("failed", job, error);

    // Continue processing
    setImmediate(() => this.processNext());
  }

  /**
   * Calculate backoff delay
   */
  private calculateBackoff(
    attempt: number,
    backoff: { type: "exponential" | "fixed"; delay: number },
  ): number {
    if (backoff.type === "fixed") {
      return backoff.delay;
    }

    // Exponential backoff with jitter
    const baseDelay = backoff.delay;
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter

    return Math.floor(exponentialDelay + jitter);
  }

  /**
   * Maintain job history limits
   */
  private maintainHistory(type: "completed" | "failed"): void {
    const list = type === "completed" ? this.completed : this.failed;
    const limit =
      type === "completed"
        ? this.options.defaultJobOptions!.removeOnComplete!
        : this.options.defaultJobOptions!.removeOnFail!;

    while (list.length > limit) {
      list.shift();
    }
  }

  /**
   * Update job progress
   */
  updateJobProgress(job: Job, progress: number): void {
    job.progress = Math.max(0, Math.min(100, progress));
    this.emit("progress", job, progress);
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    pending: number;
    active: number;
    completed: number;
    failed: number;
    total: number;
  } {
    return {
      pending: this.pending.length,
      active: this.active.size,
      completed: this.completed.length,
      failed: this.failed.length,
      total:
        this.pending.length +
        this.active.size +
        this.completed.length +
        this.failed.length,
    };
  }
}
