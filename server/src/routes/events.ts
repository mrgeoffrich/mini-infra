import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { getLogger } from '../lib/logger-factory';
import {
  requirePermission,
  getAuthenticatedUser,
} from '../middleware/auth';
import { UserEventService } from '../services/user-events';
import prisma from '../lib/prisma';
import {
  CreateUserEventRequest,
  UpdateUserEventRequest,
  UserEventListResponse,
  UserEventResponse,
  DeleteUserEventResponse,
  UserEventFilter,
  UserEventSortOptions,
  UserEventStatisticsResponse,
  USER_EVENT_STATUSES,
} from '@mini-infra/types';

const logger = getLogger("platform", "events");
const router = express.Router();

// Initialize service
const userEventService = new UserEventService(prisma);

// ====================
// Validation Schemas
// ====================

const createEventSchema = z.object({
  eventType: z.string().min(1, 'Event type is required'),
  eventCategory: z.string().min(1, 'Event category is required'),
  eventName: z.string().min(1, 'Event name is required'),
  userId: z.string().optional(),
  triggeredBy: z.string().min(1, 'Triggered by is required'),
  status: z.enum(USER_EVENT_STATUSES).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  resourceId: z.string().optional(),
  resourceType: z.string().optional(),
  resourceName: z.string().optional(),
  description: z.string().optional(),
  metadata: z.any().optional(),
  expiresAt: z.string().datetime().optional(),
});

const updateEventSchema = z.object({
  status: z.enum(USER_EVENT_STATUSES).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().optional(),
  resultSummary: z.string().optional(),
  errorMessage: z.string().optional(),
  errorDetails: z.any().optional(),
  logs: z.string().optional(),
  metadata: z.any().optional(),
});

const appendLogsSchema = z.object({
  logs: z.string().min(1, 'Logs are required'),
});

// ====================
// Helper Functions
// ====================

/**
 * Validation middleware wrapper
 */
function validate(schema: z.ZodSchema): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: error.issues.map((e: z.ZodIssue) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
      } else {
        next(error);
      }
    }
  };
}

/**
 * Build filter object from query parameters
 */
function buildFilterFromQuery(query: Record<string, unknown>): UserEventFilter {
  const filter: UserEventFilter = {};
  const asArray = <T>(v: unknown): T[] =>
    Array.isArray(v) ? (v as T[]) : [v as T];

  if (query.eventType) {
    filter.eventType = asArray(query.eventType);
  }
  if (query.eventCategory) {
    filter.eventCategory = asArray(query.eventCategory);
  }
  if (query.status) {
    filter.status = asArray(query.status);
  }
  if (query.userId) {
    filter.userId = query.userId as string;
  }
  if (query.resourceType) {
    filter.resourceType = asArray(query.resourceType);
  }
  if (query.resourceId) {
    filter.resourceId = query.resourceId as string;
  }
  if (query.startDate) {
    filter.startDate = query.startDate as string;
  }
  if (query.endDate) {
    filter.endDate = query.endDate as string;
  }
  if (query.search) {
    filter.search = query.search as string;
  }

  return filter;
}

// ====================
// Routes
// ====================

/**
 * GET /api/events
 * List user events with filtering, sorting, and pagination
 */
router.get(
  '/',
  requirePermission('events:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Parse query parameters
      const filter = buildFilterFromQuery(req.query);

      const sort: UserEventSortOptions | undefined = req.query.sortField
        ? {
            field: req.query.sortField as keyof import('@mini-infra/types').UserEventInfo,
            order: (req.query.sortOrder as 'asc' | 'desc') || 'desc',
          }
        : undefined;

      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : 50;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string, 10)
        : 0;

      // Validate pagination parameters
      if (isNaN(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({
          success: false,
          message: 'Limit must be between 1 and 100',
        });
      }

      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({
          success: false,
          message: 'Offset must be a non-negative number',
        });
      }

      // Get events
      const { events, totalCount } = await userEventService.listEvents(
        filter,
        sort,
        limit,
        offset,
      );

      const response: UserEventListResponse = {
        success: true,
        data: events,
        pagination: {
          limit,
          offset,
          totalCount,
          hasMore: offset + limit < totalCount,
        },
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        'Failed to list user events',
      );
      next(error);
    }
  },
);

/**
 * GET /api/events/statistics
 * Get statistics about user events
 */
router.get(
  '/statistics',
  requirePermission('events:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const statistics = await userEventService.getStatistics();

      const response: UserEventStatisticsResponse = {
        success: true,
        data: statistics,
      };

      res.json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        'Failed to get user event statistics',
      );
      next(error);
    }
  },
);

/**
 * GET /api/events/:id
 * Get a single user event by ID
 */
router.get(
  '/:id',
  requirePermission('events:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await userEventService.getEventById(String(req.params.id));

      if (!event) {
        return res.status(404).json({
          success: false,
          message: 'Event not found',
        });
      }

      const response: UserEventResponse = {
        success: true,
        data: event,
      };

      res.json(response);
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          eventId: req.params.id,
        },
        'Failed to get user event',
      );
      next(error);
    }
  },
);

/**
 * POST /api/events
 * Create a new user event
 */
router.post(
  '/',
  requirePermission('events:write'),
  validate(createEventSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      const requestData: CreateUserEventRequest = req.body;

      // Use authenticated user ID if not provided
      if (!requestData.userId && user) {
        requestData.userId = user.id;
      }

      const event = await userEventService.createEvent(requestData);

      const response: UserEventResponse = {
        success: true,
        data: event,
        message: 'Event created successfully',
      };

      res.status(201).json(response);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        'Failed to create user event',
      );
      next(error);
    }
  },
);

/**
 * PATCH /api/events/:id
 * Update an existing user event
 */
router.patch(
  '/:id',
  requirePermission('events:write'),
  validate(updateEventSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updateData: UpdateUserEventRequest = req.body;
      const event = await userEventService.updateEvent(String(req.params.id), updateData);

      const response: UserEventResponse = {
        success: true,
        data: event,
        message: 'Event updated successfully',
      };

      res.json(response);
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          eventId: req.params.id,
        },
        'Failed to update user event',
      );
      next(error);
    }
  },
);

/**
 * POST /api/events/:id/logs
 * Append logs to an existing user event
 */
router.post(
  '/:id/logs',
  requirePermission('events:write'),
  validate(appendLogsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { logs } = req.body;
      const event = await userEventService.appendLogs(String(req.params.id), logs);

      const response: UserEventResponse = {
        success: true,
        data: event,
        message: 'Logs appended successfully',
      };

      res.json(response);
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          eventId: req.params.id,
        },
        'Failed to append logs to user event',
      );
      next(error);
    }
  },
);

/**
 * DELETE /api/events/:id
 * Delete a user event
 */
router.delete(
  '/:id',
  requirePermission('events:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await userEventService.deleteEvent(String(req.params.id));

      const response: DeleteUserEventResponse = {
        success: true,
        message: 'Event deleted successfully',
      };

      res.json(response);
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          eventId: req.params.id,
        },
        'Failed to delete user event',
      );
      next(error);
    }
  },
);

export default router;
