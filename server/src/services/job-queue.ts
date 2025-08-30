import Queue from 'bull';
import { Job } from '@mini-infra/types';
import { JobService, CreateJobData, JobExecutionCallbacks } from './job-service.js';
import { SSEService } from './sse.js';
import logger from '../lib/logger.js';

export interface JobQueueData {
  sessionId: string;
  repositoryUrl: string;
  githubToken: string;
  storyFile: string;        // Path within repository
  architectureDoc: string;  // Path within repository
  options: {
    branchPrefix?: string;
    featureBranch?: string;
    customPrompt?: string;
  };
}

export interface JobQueueOptions {
  concurrency?: number;
  removeOnComplete?: number;
  removeOnFail?: number;
  attempts?: number;
  backoff?: 'exponential' | 'fixed';
}

export class JobQueueService {
  private jobQueue: Queue.Queue;
  private jobService: JobService;
  private sseService: SSEService;

  constructor(sseService: SSEService, options: JobQueueOptions = {}) {
    this.sseService = sseService;
    this.jobService = new JobService();
    
    // Initialize Bull queue with in-memory mode fallback
    this.jobQueue = new Queue('story processing', 'redis://127.0.0.1:6379', {
      redis: {
        port: 6379,
        host: '127.0.0.1',
        // For MVP: use in-memory fallback when Redis is unavailable
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false
      },
      defaultJobOptions: {
        removeOnComplete: options.removeOnComplete || 10,
        removeOnFail: options.removeOnFail || 5,
        attempts: options.attempts || 1,
        backoff: {
          type: options.backoff || 'exponential',
          delay: 2000
        }
      }
    });

    // Fallback to in-memory when Redis unavailable
    this.jobQueue.on('error', (error) => {
      logger.warn({ error: error.message }, 'Queue using in-memory mode due to Redis connection error');
    });

    this.setupProcessors(options.concurrency || 2);
    this.setupEventListeners();
  }

  /**
   * Setup job processors with concurrency control
   */
  private setupProcessors(concurrency: number): void {
    this.jobQueue.process('run-story', concurrency, async (job) => {
      const { sessionId, repositoryUrl, githubToken, storyFile, architectureDoc, options } = job.data as JobQueueData;
      
      logger.info({ 
        sessionId, 
        repositoryUrl, 
        storyFile, 
        architectureDoc,
        jobId: job.id 
      }, 'Starting job processing');

      try {
        // Update progress
        job.progress(5);
        this.sseService.broadcast(sessionId, {
          type: 'job-started',
          message: 'Job started, preparing to clone repository...'
        });

        // Create job in database first
        const createJobData: CreateJobData = {
          userId: 'system', // TODO: Get from authenticated user
          repositoryUrl,
          githubToken,
          storyFile,
          architectureDoc,
          branchPrefix: options.branchPrefix || 'story',
          featureBranch: options.featureBranch
        };

        const createdJob = await this.jobService.createJob(createJobData);
        
        job.progress(10);
        this.sseService.broadcast(sessionId, {
          type: 'job-progress',
          jobId: createdJob.id,
          progress: {
            current: 10,
            total: 100,
            percentage: 10,
            message: 'Job created, starting execution...'
          }
        });

        // Set up callbacks to relay progress to SSE
        const callbacks: JobExecutionCallbacks = {
          onLog: async (message: string, level: 'info' | 'error' | 'warn') => {
            this.sseService.broadcast(sessionId, {
              type: 'job-log',
              jobId: createdJob.id,
              message,
              level: level === 'warn' ? 'warning' : level,
              timestamp: new Date().toISOString()
            });
          },
          onProgress: async (current: number, total: number, message: string) => {
            // Map progress from 10-95% (leaving 5% for cleanup)
            const mappedProgress = Math.round(10 + ((current / total) * 85));
            job.progress(mappedProgress);
            this.sseService.broadcast(sessionId, {
              type: 'job-progress',
              jobId: createdJob.id,
              progress: {
                current,
                total,
                percentage: mappedProgress,
                message
              }
            });
          },
          onJobStatusChange: async (status: string) => {
            this.sseService.broadcast(sessionId, {
              type: 'job-status',
              jobId: createdJob.id,
              status: status as any, // Cast to JobStatus type
              timestamp: new Date().toISOString()
            });
          },
          onExecutionProgress: async (executionId: string, progress: number) => {
            this.sseService.broadcast(sessionId, {
              type: 'job-progress',
              jobId: createdJob.id,
              progress: {
                current: progress,
                total: 100,
                percentage: progress,
                message: 'Execution in progress...'
              }
            });
          }
        };

        // Execute the job
        await this.jobService.executeJob(createdJob.id, callbacks);
        
        job.progress(100);
        this.sseService.broadcast(sessionId, {
          type: 'job-completed',
          jobId: createdJob.id,
          status: 'completed' as any,
          message: 'Story processing completed successfully!'
        });

        logger.info({ sessionId, jobId: createdJob.id }, 'Job processing completed successfully');
        
        return { jobId: createdJob.id, result: 'success' };
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        
        logger.error({ 
          sessionId, 
          error: errorMessage,
          jobId: job.id 
        }, 'Job processing failed');

        this.sseService.broadcast(sessionId, {
          type: 'job-error',
          jobId: 'unknown', // We don't have jobId at this point if job creation failed
          error: errorMessage,
          timestamp: new Date().toISOString()
        });
        
        throw error;
      }
    });
  }

  /**
   * Setup event listeners for job lifecycle
   */
  private setupEventListeners(): void {
    this.jobQueue.on('completed', (job, result) => {
      logger.info({ jobId: job.id, result }, 'Job completed');
    });

    this.jobQueue.on('failed', (job, error) => {
      logger.error({ 
        jobId: job.id, 
        error: error.message,
        attempts: job.attemptsMade,
        maxAttempts: job.opts.attempts 
      }, 'Job failed');
    });

    this.jobQueue.on('stalled', (job) => {
      logger.warn({ jobId: job.id }, 'Job stalled');
    });

    this.jobQueue.on('progress', (job, progress) => {
      logger.debug({ jobId: job.id, progress }, 'Job progress updated');
    });
  }

  /**
   * Add a new job to the queue
   */
  async addJob(jobData: JobQueueData): Promise<string> {
    try {
      const job = await this.jobQueue.add('run-story', jobData, {
        priority: 1,
        delay: 0
      });

      logger.info({ 
        jobId: job.id, 
        sessionId: jobData.sessionId,
        repositoryUrl: jobData.repositoryUrl 
      }, 'Job added to queue');
      
      return job.id.toString();
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to add job to queue');
      throw new Error('Failed to add job to queue');
    }
  }

  /**
   * Get job status and details
   */
  async getJobStatus(jobId: string) {
    try {
      const job = await this.jobQueue.getJob(jobId);
      if (!job) return null;
      
      return {
        id: job.id,
        progress: job.progress(),
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
        data: job.data,
        opts: job.opts,
        attemptsMade: job.attemptsMade
      };
    } catch (error) {
      logger.error({ jobId, error: error instanceof Error ? error.message : error }, 'Failed to get job status');
      throw new Error('Failed to get job status');
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats() {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.jobQueue.getWaiting(),
        this.jobQueue.getActive(),
        this.jobQueue.getCompleted(),
        this.jobQueue.getFailed(),
        this.jobQueue.getDelayed()
      ]);

      return {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: delayed.length,
        paused: 0 // Bull doesn't have a getPaused method, track manually if needed
      };
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to get queue stats');
      throw new Error('Failed to get queue stats');
    }
  }

  /**
   * Remove a job from the queue
   */
  async removeJob(jobId: string): Promise<boolean> {
    try {
      const job = await this.jobQueue.getJob(jobId);
      if (!job) return false;
      
      await job.remove();
      logger.info({ jobId }, 'Job removed from queue');
      return true;
    } catch (error) {
      logger.error({ jobId, error: error instanceof Error ? error.message : error }, 'Failed to remove job');
      throw new Error('Failed to remove job');
    }
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId: string): Promise<boolean> {
    try {
      const job = await this.jobQueue.getJob(jobId);
      if (!job) return false;
      
      await job.retry();
      logger.info({ jobId }, 'Job scheduled for retry');
      return true;
    } catch (error) {
      logger.error({ jobId, error: error instanceof Error ? error.message : error }, 'Failed to retry job');
      throw new Error('Failed to retry job');
    }
  }

  /**
   * Clean completed and failed jobs
   */
  async cleanJobs(grace: number = 5000): Promise<void> {
    try {
      await this.jobQueue.clean(grace, 'completed');
      await this.jobQueue.clean(grace, 'failed');
      logger.info({ grace }, 'Queue cleaned');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to clean queue');
      throw new Error('Failed to clean queue');
    }
  }

  /**
   * Pause the queue
   */
  async pause(): Promise<void> {
    try {
      await this.jobQueue.pause();
      logger.info('Queue paused');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to pause queue');
      throw new Error('Failed to pause queue');
    }
  }

  /**
   * Resume the queue
   */
  async resume(): Promise<void> {
    try {
      await this.jobQueue.resume();
      logger.info('Queue resumed');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to resume queue');
      throw new Error('Failed to resume queue');
    }
  }

  /**
   * Shutdown the queue service
   */
  async shutdown(): Promise<void> {
    try {
      await this.jobQueue.close();
      logger.info('Job queue service shut down');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'Error shutting down job queue service');
    }
  }
}

// Export singleton instance
export const jobQueueService = new JobQueueService(
  require('./sse.js').sseService
);