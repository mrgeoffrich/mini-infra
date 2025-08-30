import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import { authMiddleware, getAuthenticatedUser } from '../lib/auth-middleware.js';
import { jobQueueService } from '../services/job-queue.js';
import { sseService } from '../services/sse.js';
import { JobService } from '../services/job-service.js';
import type { 
  CreateJobRequest, 
  JobResponse, 
  JobListResponse, 
  JobExecutionResponse,
  ApiResponse,
  ValidationError 
} from '@mini-infra/types';

const router = Router();
const jobService = new JobService();

// Input validation schemas
const createJobSchema = z.object({
  repositoryUrl: z.string().url('Repository URL must be a valid URL'),
  githubToken: z.string().min(1, 'GitHub token is required'),
  storyFile: z.string().min(1, 'Story file path is required'),
  architectureDoc: z.string().min(1, 'Architecture document path is required'),
  branchPrefix: z.string().optional(),
  featureBranch: z.string().optional(),
  customPrompt: z.string().optional()
});

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20)
});

const jobIdSchema = z.object({
  jobId: z.string().uuid('Invalid job ID format')
});

/**
 * POST /api/jobs - Create a new job
 * Requires authentication
 */
router.post('/', authMiddleware.requireJwt, async (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'] as string;
  const user = getAuthenticatedUser(req);
  
  if (!user) {
    logger.warn({ requestId }, 'Create job failed: user not authenticated');
    return res.status(401).json({
      error: 'Authentication required',
      message: 'You must be logged in to create jobs',
      timestamp: new Date().toISOString(),
      requestId
    });
  }

  try {
    // Validate request body
    const validation = createJobSchema.safeParse(req.body);
    
    if (!validation.success) {
      logger.warn({ 
        requestId, 
        userId: user.id, 
        errors: validation.error.issues 
      }, 'Create job validation failed');
      
      const validationError: ValidationError = {
        error: 'Validation Error',
        message: 'Invalid request data',
        details: validation.error.issues.map(err => ({
          code: err.code,
          path: err.path.map(p => String(p)),
          message: err.message,
          expected: 'valid input',
          received: String('input' in err ? err.input : '')
        })),
        timestamp: new Date().toISOString(),
        requestId
      };
      
      return res.status(400).json(validationError);
    }

    const jobData = validation.data;
    const sessionId = uuidv4();

    logger.info({ 
      requestId, 
      userId: user.id, 
      repositoryUrl: jobData.repositoryUrl,
      sessionId
    }, 'Creating new job');

    // Create job in database
    const job = await jobService.createJob({
      userId: user.id,
      repositoryUrl: jobData.repositoryUrl,
      githubToken: jobData.githubToken, // TODO: Encrypt this
      storyFile: jobData.storyFile,
      architectureDoc: jobData.architectureDoc,
      branchPrefix: jobData.branchPrefix || 'story',
      featureBranch: jobData.featureBranch
    });

    // Add job to processing queue
    const queueJobId = await jobQueueService.addJob({
      sessionId,
      repositoryUrl: jobData.repositoryUrl,
      githubToken: jobData.githubToken,
      storyFile: jobData.storyFile,
      architectureDoc: jobData.architectureDoc,
      options: {
        branchPrefix: jobData.branchPrefix,
        featureBranch: jobData.featureBranch,
        customPrompt: jobData.customPrompt
      }
    });

    logger.info({ 
      requestId, 
      userId: user.id, 
      jobId: job.id,
      queueJobId,
      sessionId
    }, 'Job created and added to queue');

    const response: ApiResponse<{ 
      job: JobResponse, 
      sessionId: string, 
      streamUrl: string 
    }> = {
      success: true,
      data: {
        job: {
          id: job.id,
          userId: job.userId,
          repositoryUrl: job.repositoryUrl,
          storyFile: job.storyFile,
          architectureDoc: job.architectureDoc,
          branchPrefix: job.branchPrefix,
          featureBranch: job.featureBranch,
          status: job.status as any,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString()
        },
        sessionId,
        streamUrl: `/api/jobs/${job.id}/stream?sessionId=${sessionId}`
      },
      message: 'Job created successfully',
      timestamp: new Date().toISOString(),
      requestId
    };

    res.status(201).json(response);

  } catch (error) {
    logger.error({ 
      requestId, 
      userId: user?.id, 
      error: error instanceof Error ? error.message : error 
    }, 'Failed to create job');
    
    next(error);
  }
});

/**
 * GET /api/jobs - List user's jobs with pagination
 * Requires authentication
 */
router.get('/', authMiddleware.requireJwt, async (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'] as string;
  const user = getAuthenticatedUser(req);
  
  if (!user) {
    logger.warn({ requestId }, 'List jobs failed: user not authenticated');
    return res.status(401).json({
      error: 'Authentication required',
      message: 'You must be logged in to view jobs',
      timestamp: new Date().toISOString(),
      requestId
    });
  }

  try {
    // Validate query parameters
    const validation = paginationSchema.safeParse(req.query);
    
    if (!validation.success) {
      logger.warn({ 
        requestId, 
        userId: user.id, 
        errors: validation.error.issues 
      }, 'List jobs validation failed');
      
      const validationError: ValidationError = {
        error: 'Validation Error',
        message: 'Invalid query parameters',
        details: validation.error.issues.map(err => ({
          code: err.code,
          path: err.path.map(p => String(p)),
          message: err.message,
          expected: 'valid input',
          received: String('input' in err ? err.input : '')
        })),
        timestamp: new Date().toISOString(),
        requestId
      };
      
      return res.status(400).json(validationError);
    }

    const { page, limit } = validation.data;
    const offset = (page - 1) * limit;

    logger.debug({ 
      requestId, 
      userId: user.id, 
      page, 
      limit, 
      offset 
    }, 'Listing user jobs');

    // Get total count for pagination
    const totalCount = await prisma.job.count({
      where: { userId: user.id }
    });

    // Get paginated jobs
    const jobs = await prisma.job.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        jobExecutions: {
          orderBy: { createdAt: 'desc' },
          take: 1 // Get the latest execution
        }
      }
    });

    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    const response: JobListResponse = {
      data: jobs.map(job => ({
        id: job.id,
        userId: job.userId,
        repositoryUrl: job.repositoryUrl,
        storyFile: job.storyFile,
        architectureDoc: job.architectureDoc,
        branchPrefix: job.branchPrefix || undefined,
        featureBranch: job.featureBranch || undefined,
        status: job.status as any,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        execution: job.jobExecutions[0] ? {
          id: job.jobExecutions[0].id,
          jobId: job.jobExecutions[0].jobId,
          sessionId: job.jobExecutions[0].sessionId,
          status: job.jobExecutions[0].status as any,
          progress: job.jobExecutions[0].progress ? {
            current: job.jobExecutions[0].progress,
            total: 100,
            percentage: job.jobExecutions[0].progress,
            message: 'Job execution in progress'
          } : undefined,
          startedAt: job.jobExecutions[0].startedAt?.toISOString(),
          completedAt: job.jobExecutions[0].completedAt?.toISOString(),
          error: job.jobExecutions[0].error || undefined
        } : undefined
      })),
      totalCount,
      page,
      limit,
      totalPages,
      hasNextPage,
      hasPreviousPage
    };

    logger.info({ 
      requestId, 
      userId: user.id, 
      totalCount, 
      page, 
      limit,
      returnedCount: jobs.length
    }, 'User jobs retrieved successfully');

    res.json(response);

  } catch (error) {
    logger.error({ 
      requestId, 
      userId: user?.id, 
      error: error instanceof Error ? error.message : error 
    }, 'Failed to list jobs');
    
    next(error);
  }
});

/**
 * GET /api/jobs/:jobId - Get job details
 * Requires authentication and job ownership
 */
router.get('/:jobId', authMiddleware.requireJwt, async (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'] as string;
  const user = getAuthenticatedUser(req);
  
  if (!user) {
    logger.warn({ requestId }, 'Get job failed: user not authenticated');
    return res.status(401).json({
      error: 'Authentication required',
      message: 'You must be logged in to view job details',
      timestamp: new Date().toISOString(),
      requestId
    });
  }

  try {
    // Validate job ID parameter
    const validation = jobIdSchema.safeParse(req.params);
    
    if (!validation.success) {
      logger.warn({ 
        requestId, 
        userId: user.id, 
        jobId: req.params.jobId,
        errors: validation.error.issues 
      }, 'Get job validation failed');
      
      const validationError: ValidationError = {
        error: 'Validation Error',
        message: 'Invalid job ID',
        details: validation.error.issues.map(err => ({
          code: err.code,
          path: err.path.map(p => String(p)),
          message: err.message,
          expected: 'valid UUID',
          received: String('input' in err ? err.input : '')
        })),
        timestamp: new Date().toISOString(),
        requestId
      };
      
      return res.status(400).json(validationError);
    }

    const { jobId } = validation.data;

    logger.debug({ 
      requestId, 
      userId: user.id, 
      jobId 
    }, 'Getting job details');

    // Get job with executions and verify ownership
    const job = await prisma.job.findFirst({
      where: { 
        id: jobId,
        userId: user.id // Ensure user can only access their own jobs
      },
      include: {
        jobExecutions: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!job) {
      logger.warn({ 
        requestId, 
        userId: user.id, 
        jobId 
      }, 'Job not found or access denied');
      
      return res.status(404).json({
        error: 'Job not found',
        message: 'Job not found or you do not have access to it',
        timestamp: new Date().toISOString(),
        requestId
      });
    }

    const response: ApiResponse<JobResponse> = {
      success: true,
      data: {
        id: job.id,
        userId: job.userId,
        repositoryUrl: job.repositoryUrl,
        storyFile: job.storyFile,
        architectureDoc: job.architectureDoc,
        branchPrefix: job.branchPrefix || undefined,
        featureBranch: job.featureBranch || undefined,
        status: job.status as any,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        execution: job.jobExecutions[0] ? {
          id: job.jobExecutions[0].id,
          jobId: job.jobExecutions[0].jobId,
          sessionId: job.jobExecutions[0].sessionId,
          status: job.jobExecutions[0].status as any,
          progress: job.jobExecutions[0].progress ? {
            current: job.jobExecutions[0].progress,
            total: 100,
            percentage: job.jobExecutions[0].progress,
            message: 'Job execution in progress'
          } : undefined,
          startedAt: job.jobExecutions[0].startedAt?.toISOString(),
          completedAt: job.jobExecutions[0].completedAt?.toISOString(),
          error: job.jobExecutions[0].error || undefined
        } : undefined
      },
      message: 'Job details retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId
    };

    logger.info({ 
      requestId, 
      userId: user.id, 
      jobId,
      status: job.status,
      executions: job.jobExecutions.length
    }, 'Job details retrieved successfully');

    res.json(response);

  } catch (error) {
    logger.error({ 
      requestId, 
      userId: user?.id, 
      jobId: req.params.jobId,
      error: error instanceof Error ? error.message : error 
    }, 'Failed to get job details');
    
    next(error);
  }
});

/**
 * GET /api/jobs/:jobId/stream - SSE stream for job updates
 * Requires authentication and job ownership
 */
router.get('/:jobId/stream', authMiddleware.requireJwt, async (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'] as string;
  const user = getAuthenticatedUser(req);
  
  if (!user) {
    logger.warn({ requestId }, 'Job stream failed: user not authenticated');
    return res.status(401).json({
      error: 'Authentication required',
      message: 'You must be logged in to stream job updates',
      timestamp: new Date().toISOString(),
      requestId
    });
  }

  try {
    // Validate job ID parameter
    const validation = jobIdSchema.safeParse(req.params);
    
    if (!validation.success) {
      logger.warn({ 
        requestId, 
        userId: user.id, 
        jobId: req.params.jobId,
        errors: validation.error.issues 
      }, 'Job stream validation failed');
      
      const validationError: ValidationError = {
        error: 'Validation Error',
        message: 'Invalid job ID',
        details: validation.error.issues.map(err => ({
          code: err.code,
          path: err.path.map(p => String(p)),
          message: err.message,
          expected: 'valid UUID',
          received: String('input' in err ? err.input : '')
        })),
        timestamp: new Date().toISOString(),
        requestId
      };
      
      return res.status(400).json(validationError);
    }

    const { jobId } = validation.data;
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
      logger.warn({ 
        requestId, 
        userId: user.id, 
        jobId 
      }, 'Job stream failed: missing sessionId');
      
      return res.status(400).json({
        error: 'Missing sessionId',
        message: 'sessionId query parameter is required for streaming',
        timestamp: new Date().toISOString(),
        requestId
      });
    }

    logger.debug({ 
      requestId, 
      userId: user.id, 
      jobId,
      sessionId
    }, 'Setting up job stream');

    // Verify job ownership
    const job = await prisma.job.findFirst({
      where: { 
        id: jobId,
        userId: user.id // Ensure user can only access their own jobs
      }
    });

    if (!job) {
      logger.warn({ 
        requestId, 
        userId: user.id, 
        jobId 
      }, 'Job stream failed: job not found or access denied');
      
      return res.status(404).json({
        error: 'Job not found',
        message: 'Job not found or you do not have access to it',
        timestamp: new Date().toISOString(),
        requestId
      });
    }

    // Connect to SSE service
    sseService.connect(sessionId, res, jobId);

    logger.info({ 
      requestId, 
      userId: user.id, 
      jobId,
      sessionId
    }, 'Job stream connected');

    // The connection is now handled by the SSE service
    // No response needed - SSE service will manage the connection

  } catch (error) {
    logger.error({ 
      requestId, 
      userId: user?.id, 
      jobId: req.params.jobId,
      error: error instanceof Error ? error.message : error 
    }, 'Failed to setup job stream');
    
    next(error);
  }
});

export default router;