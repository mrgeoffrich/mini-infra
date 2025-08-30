import { query } from '@anthropic-ai/claude-code';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Job, JobExecution, JobLog } from '@mini-infra/types';
import prisma from '../lib/prisma.js';
import { GitService, StreamCallback } from './git-service.js';
import logger from '../lib/logger.js';

export interface JobServiceOptions {
  workspaceRoot?: string;
  timeout?: number;
}

export interface JobExecutionCallbacks extends StreamCallback {
  onJobStatusChange?: (status: string) => void;
  onExecutionProgress?: (executionId: string, progress: number) => void;
}

export interface CreateJobData {
  userId: string;
  repositoryUrl: string;
  githubToken: string;
  storyFile: string;
  architectureDoc: string;
  branchPrefix?: string;
  featureBranch?: string;
}

export class JobService {
  private gitService: GitService;

  constructor(options: JobServiceOptions = {}) {
    this.gitService = new GitService({
      workspaceRoot: options.workspaceRoot,
      timeout: options.timeout
    });
  }

  /**
   * Create a new job and save to database
   */
  async createJob(jobData: CreateJobData): Promise<Job> {
    try {
      const job = await prisma.job.create({
        data: {
          id: uuidv4(),
          userId: jobData.userId,
          repositoryUrl: jobData.repositoryUrl,
          githubToken: jobData.githubToken, // TODO: Encrypt this
          storyFile: jobData.storyFile,
          architectureDoc: jobData.architectureDoc,
          branchPrefix: jobData.branchPrefix || 'story',
          featureBranch: jobData.featureBranch,
          status: 'pending'
        }
      });

      logger.info({ jobId: job.id, userId: jobData.userId }, 'Job created successfully');
      return job as Job;

    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to create job');
      throw new Error('Failed to create job');
    }
  }

  /**
   * Execute a job with streaming output and progress tracking
   */
  async executeJob(jobId: string, callbacks?: JobExecutionCallbacks): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const sessionId = uuidv4();
    const executionId = uuidv4();

    // Create job execution record
    const execution = await prisma.jobExecution.create({
      data: {
        id: executionId,
        jobId: jobId,
        sessionId: sessionId,
        status: 'pending',
        progress: 0
      }
    });

    try {
      // Update job status to running
      await this.updateJobStatus(jobId, 'running');
      callbacks?.onJobStatusChange?.('running');

      // Update execution status
      await this.updateExecutionStatus(executionId, 'running');
      await this.updateExecutionProgress(executionId, 10);
      callbacks?.onExecutionProgress?.(executionId, 10);

      await this.logJobMessage(jobId, 'Starting job execution', 'info');

      // Create streaming callbacks that save to database
      const streamCallbacks: StreamCallback = {
        onLog: async (message: string, level: 'info' | 'error' | 'warn') => {
          await this.logJobMessage(jobId, message, level);
          callbacks?.onLog?.(message, level);
        },
        onProgress: async (current: number, total: number, message: string) => {
          const percentage = Math.round((current / total) * 100);
          await this.updateExecutionProgress(executionId, percentage);
          callbacks?.onProgress?.(current, total, message);
          callbacks?.onExecutionProgress?.(executionId, percentage);
        }
      };

      // Clone repository
      streamCallbacks.onProgress?.(10, 100, 'Cloning repository...');
      const repoPath = await this.gitService.cloneRepository(
        sessionId,
        job.repositoryUrl,
        job.githubToken,
        streamCallbacks
      );

      streamCallbacks.onProgress?.(30, 100, 'Repository cloned, preparing Claude Code execution...');

      // Prepare file paths
      const storyFilePath = path.join(repoPath, job.storyFile);
      const architectureDocPath = path.join(repoPath, job.architectureDoc);

      // Validate files exist
      if (!fs.existsSync(storyFilePath)) {
        throw new Error(`Story file not found: ${job.storyFile}`);
      }
      if (!fs.existsSync(architectureDocPath)) {
        throw new Error(`Architecture document not found: ${job.architectureDoc}`);
      }

      streamCallbacks.onProgress?.(40, 100, 'Starting Claude Code execution...');

      // Execute Claude Code
      await this.runClaudeCodeOnStory(
        storyFilePath,
        architectureDocPath,
        repoPath,
        streamCallbacks
      );

      streamCallbacks.onProgress?.(95, 100, 'Cleaning up workspace...');

      // Cleanup workspace
      await this.gitService.cleanupSession(sessionId);

      streamCallbacks.onProgress?.(100, 100, 'Job completed successfully!');

      // Mark execution and job as completed
      await this.updateExecutionStatus(executionId, 'completed', new Date());
      await this.updateJobStatus(jobId, 'completed');
      callbacks?.onJobStatusChange?.('completed');

      await this.logJobMessage(jobId, 'Job execution completed successfully', 'info');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      
      // Log error
      await this.logJobMessage(jobId, `Job execution failed: ${errorMessage}`, 'error');
      
      // Update execution with error
      await this.updateExecutionStatus(executionId, 'failed', new Date(), errorMessage);
      await this.updateJobStatus(jobId, 'failed');
      callbacks?.onJobStatusChange?.('failed');

      // Cleanup workspace on failure
      await this.gitService.cleanupSession(sessionId);

      logger.error({ jobId, executionId, error: errorMessage }, 'Job execution failed');
      throw error;
    }
  }

  /**
   * Execute Claude Code on the story files with streaming output
   */
  private async runClaudeCodeOnStory(
    storyFile: string,
    architectureDoc: string,
    workingDirectory: string,
    callbacks?: StreamCallback
  ): Promise<void> {
    callbacks?.onLog?.(`Starting Claude Code execution`, 'info');
    callbacks?.onLog?.(`Story File: ${storyFile}`, 'info');
    callbacks?.onLog?.(`Architecture Doc: ${architectureDoc}`, 'info');

    const prompt = `/implement-story ${storyFile} ${architectureDoc}`;
    const claudeCodePath = this.getClaudeCodeExecutablePath();

    try {
      let messageCount = 0;
      
      for await (const message of query({
        prompt,
        options: {
          maxTurns: 200,
          abortController: new AbortController(),
          pathToClaudeCodeExecutable: claudeCodePath,
          cwd: workingDirectory,
          permissionMode: "bypassPermissions"
        }
      })) {
        messageCount++;
        
        // Log Claude Code messages
        if (message && typeof message === 'object') {
          const messageStr = this.formatClaudeMessage(message);
          if (messageStr) {
            callbacks?.onLog?.(messageStr, 'info');
          }
          
          // Check for completion
          if (message.type === 'result' && message.subtype === 'success') {
            callbacks?.onLog?.('Story implementation completed successfully!', 'info');
            return;
          }
          
          // Update progress based on message count (rough estimate)
          if (messageCount % 5 === 0) {
            const estimatedProgress = Math.min(40 + (messageCount * 2), 90);
            callbacks?.onProgress?.(estimatedProgress, 100, `Processing Claude Code messages...`);
          }
        }
      }
      
      callbacks?.onLog?.('Claude Code execution completed', 'info');
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      callbacks?.onLog?.(`Claude Code execution failed: ${errorMessage}`, 'error');
      throw new Error(`Claude Code execution failed: ${errorMessage}`);
    }
  }

  /**
   * Format Claude Code messages for logging
   */
  private formatClaudeMessage(message: any): string {
    if (!message) return '';
    
    try {
      if (message.type === 'system' && message.subtype === 'init') {
        return `🚀 Claude Code Session Started - Model: ${message.model}, Tools: ${message.tools?.length || 0}`;
      }
      
      if (message.type === 'assistant' && message.message?.content) {
        const textContent = message.message.content
          .filter((item: any) => item.type === 'text' && item.text)
          .map((item: any) => item.text)
          .join('\n');
        
        if (textContent) {
          return `🤖 Claude: ${textContent.substring(0, 200)}${textContent.length > 200 ? '...' : ''}`;
        }
        
        const toolUses = message.message.content
          .filter((item: any) => item.type === 'tool_use')
          .map((item: any) => item.name);
        
        if (toolUses.length > 0) {
          return `🔧 Using tools: ${toolUses.join(', ')}`;
        }
      }
      
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          return `✅ Story Implementation Complete!`;
        } else if (message.subtype === 'error') {
          return `❌ Error: ${message.result}`;
        }
      }
      
      return ''; // Skip other message types
      
    } catch (error) {
      return `[Message parsing error: ${error instanceof Error ? error.message : error}]`;
    }
  }

  /**
   * Get Claude Code executable path
   */
  private getClaudeCodeExecutablePath(): string {
    try {
      // Get npm global prefix
      const npmPrefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();

      // The SDK expects the actual CLI file, not the wrapper
      const claudePath = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

      // Check if file exists
      if (!fs.existsSync(claudePath)) {
        throw new Error(`Claude Code CLI not found at ${claudePath}. Please check if Claude Code is installed globally.`);
      }

      return claudePath;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Could not determine Claude Code executable path. Is Claude Code installed globally?');
    }
  }

  /**
   * Get job by ID
   */
  async getJob(jobId: string): Promise<Job | null> {
    try {
      const job = await prisma.job.findUnique({
        where: { id: jobId }
      });
      return job as Job | null;
    } catch (error) {
      logger.error({ jobId, error: error instanceof Error ? error.message : error }, 'Failed to get job');
      throw new Error('Failed to get job');
    }
  }

  /**
   * Get jobs for a user with pagination
   */
  async getUserJobs(userId: string, limit = 20, offset = 0): Promise<Job[]> {
    try {
      const jobs = await prisma.job.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset
      });
      return jobs as Job[];
    } catch (error) {
      logger.error({ userId, error: error instanceof Error ? error.message : error }, 'Failed to get user jobs');
      throw new Error('Failed to get user jobs');
    }
  }

  /**
   * Update job status
   */
  private async updateJobStatus(jobId: string, status: string): Promise<void> {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: { 
          status,
          updatedAt: new Date()
        }
      });
    } catch (error) {
      logger.error({ jobId, status, error: error instanceof Error ? error.message : error }, 'Failed to update job status');
    }
  }

  /**
   * Update execution status
   */
  private async updateExecutionStatus(
    executionId: string, 
    status: string, 
    completedAt?: Date,
    error?: string
  ): Promise<void> {
    try {
      const updateData: any = { 
        status,
        updatedAt: new Date()
      };
      
      if (status === 'running' && !completedAt) {
        updateData.startedAt = new Date();
      }
      
      if (completedAt) {
        updateData.completedAt = completedAt;
      }
      
      if (error) {
        updateData.error = error;
      }

      await prisma.jobExecution.update({
        where: { id: executionId },
        data: updateData
      });
    } catch (error) {
      logger.error({ 
        executionId, 
        status, 
        error: error instanceof Error ? error.message : error 
      }, 'Failed to update execution status');
    }
  }

  /**
   * Update execution progress
   */
  private async updateExecutionProgress(executionId: string, progress: number): Promise<void> {
    try {
      await prisma.jobExecution.update({
        where: { id: executionId },
        data: { 
          progress,
          updatedAt: new Date()
        }
      });
    } catch (error) {
      logger.error({ 
        executionId, 
        progress, 
        error: error instanceof Error ? error.message : error 
      }, 'Failed to update execution progress');
    }
  }

  /**
   * Log a message for a job
   */
  private async logJobMessage(
    jobId: string, 
    message: string, 
    level: 'info' | 'error' | 'warn' = 'info'
  ): Promise<void> {
    try {
      await prisma.jobLog.create({
        data: {
          id: uuidv4(),
          jobId,
          logEntry: message,
          level,
          timestamp: new Date()
        }
      });
    } catch (error) {
      logger.error({ 
        jobId, 
        message, 
        level,
        error: error instanceof Error ? error.message : error 
      }, 'Failed to log job message');
    }
  }

  /**
   * Get job logs
   */
  async getJobLogs(jobId: string): Promise<JobLog[]> {
    try {
      const logs = await prisma.jobLog.findMany({
        where: { jobId },
        orderBy: { timestamp: 'asc' }
      });
      
      return logs.map((log: any) => ({
        id: log.id,
        jobId: log.jobId,
        timestamp: log.timestamp,
        level: log.level as 'info' | 'error' | 'warning' | 'debug',
        message: log.logEntry,
      }));
    } catch (error) {
      logger.error({ jobId, error: error instanceof Error ? error.message : error }, 'Failed to get job logs');
      throw new Error('Failed to get job logs');
    }
  }
}