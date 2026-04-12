import prisma, { PrismaClient } from '../../lib/prisma';
import { servicesLogger } from '../../lib/logger-factory';
import {
  UserEventInfo,
  UserEventFilter,
  UserEventSortOptions,
  CreateUserEventRequest,
  UpdateUserEventRequest,
  Channel,
  ServerEvent,
} from '@mini-infra/types';
import { emitToChannel } from '../../lib/socket';
import type { UserEvent } from '@prisma/client';

/**
 * UserEventService manages user events for tracking long-running operations
 */
export class UserEventService {
  private prisma: PrismaClient;
  private logger = servicesLogger();

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || prisma;
  }

  /**
   * Create a new user event
   */
  async createEvent(data: CreateUserEventRequest): Promise<UserEventInfo> {
    try {
      this.logger.debug(
        {
          eventType: data.eventType,
          eventName: data.eventName,
          userId: data.userId,
        },
        'Creating new user event',
      );

      const event = await this.prisma.userEvent.create({
        data: {
          eventType: data.eventType,
          eventCategory: data.eventCategory,
          eventName: data.eventName,
          userId: data.userId,
          triggeredBy: data.triggeredBy,
          status: data.status || 'pending',
          progress: data.progress || 0,
          resourceId: data.resourceId,
          resourceType: data.resourceType,
          resourceName: data.resourceName,
          description: data.description,
          metadata: data.metadata ? JSON.stringify(data.metadata) : null,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      });

      this.logger.info(
        {
          eventId: event.id,
          eventType: event.eventType,
          eventName: event.eventName,
        },
        'User event created successfully',
      );

      const eventInfo = this.toEventInfo(event);

      // Emit via Socket.IO
      try {
        emitToChannel(Channel.EVENTS, ServerEvent.EVENT_CREATED, eventInfo);
      } catch (emitError) {
        this.logger.error(
          { eventId: event.id, error: emitError instanceof Error ? emitError.message : emitError },
          'Failed to emit event:created via socket',
        );
      }

      return eventInfo;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          eventType: data.eventType,
        },
        'Failed to create user event',
      );
      throw error;
    }
  }

  /**
   * Update an existing user event
   */
  async updateEvent(
    eventId: string,
    data: UpdateUserEventRequest,
  ): Promise<UserEventInfo> {
    try {
      this.logger.debug(
        {
          eventId,
          status: data.status,
          progress: data.progress,
        },
        'Updating user event',
      );

      const updateData: any = {};

      if (data.status !== undefined) updateData.status = data.status;
      if (data.progress !== undefined) updateData.progress = data.progress;
      if (data.completedAt !== undefined) {
        updateData.completedAt = data.completedAt
          ? new Date(data.completedAt)
          : null;
      }
      if (data.durationMs !== undefined) updateData.durationMs = data.durationMs;
      if (data.resultSummary !== undefined)
        updateData.resultSummary = data.resultSummary;
      if (data.errorMessage !== undefined)
        updateData.errorMessage = data.errorMessage;
      if (data.errorDetails !== undefined) {
        updateData.errorDetails = data.errorDetails
          ? JSON.stringify(data.errorDetails)
          : null;
      }
      if (data.logs !== undefined) updateData.logs = data.logs;
      if (data.metadata !== undefined) {
        updateData.metadata = data.metadata
          ? JSON.stringify(data.metadata)
          : null;
      }

      // Auto-calculate duration if completing event
      if (data.status === 'completed' || data.status === 'failed') {
        if (!data.completedAt) {
          updateData.completedAt = new Date();
        }
        if (data.durationMs === undefined) {
          const event = await this.prisma.userEvent.findUnique({
            where: { id: eventId },
            select: { startedAt: true },
          });
          if (event) {
            const completedAt = updateData.completedAt || new Date();
            updateData.durationMs =
              completedAt.getTime() - event.startedAt.getTime();
          }
        }
      }

      const event = await this.prisma.userEvent.update({
        where: { id: eventId },
        data: updateData,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      });

      this.logger.debug(
        {
          eventId: event.id,
          status: event.status,
          progress: event.progress,
        },
        'User event updated successfully',
      );

      const eventInfo = this.toEventInfo(event);

      // Emit via Socket.IO
      try {
        emitToChannel(Channel.EVENTS, ServerEvent.EVENT_UPDATED, eventInfo);
      } catch (emitError) {
        this.logger.error(
          { eventId: event.id, error: emitError instanceof Error ? emitError.message : emitError },
          'Failed to emit event:updated via socket',
        );
      }

      return eventInfo;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          eventId,
        },
        'Failed to update user event',
      );
      throw error;
    }
  }

  /**
   * Append logs to an existing user event
   */
  async appendLogs(eventId: string, newLogs: string): Promise<UserEventInfo> {
    try {
      const event = await this.prisma.userEvent.findUnique({
        where: { id: eventId },
        select: { logs: true },
      });

      if (!event) {
        throw new Error(`User event not found: ${eventId}`);
      }

      const existingLogs = event.logs || '';
      const updatedLogs = existingLogs
        ? `${existingLogs}\n${newLogs}`
        : newLogs;

      return this.updateEvent(eventId, { logs: updatedLogs });
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          eventId,
        },
        'Failed to append logs to user event',
      );
      throw error;
    }
  }

  /**
   * Get a user event by ID
   */
  async getEventById(eventId: string): Promise<UserEventInfo | null> {
    try {
      const event = await this.prisma.userEvent.findUnique({
        where: { id: eventId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      });

      if (!event) {
        return null;
      }

      return this.toEventInfo(event);
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          eventId,
        },
        'Failed to get user event',
      );
      throw error;
    }
  }

  /**
   * List user events with filtering, sorting, and pagination
   */
  async listEvents(
    filter?: UserEventFilter,
    sort?: UserEventSortOptions,
    limit: number = 50,
    offset: number = 0,
  ): Promise<{ events: UserEventInfo[]; totalCount: number }> {
    try {
      const where: any = {};

      // Apply filters
      if (filter) {
        if (filter.eventType) {
          where.eventType = Array.isArray(filter.eventType)
            ? { in: filter.eventType }
            : filter.eventType;
        }
        if (filter.eventCategory) {
          where.eventCategory = Array.isArray(filter.eventCategory)
            ? { in: filter.eventCategory }
            : filter.eventCategory;
        }
        if (filter.status) {
          where.status = Array.isArray(filter.status)
            ? { in: filter.status }
            : filter.status;
        }
        if (filter.userId) {
          where.userId = filter.userId;
        }
        if (filter.resourceType) {
          where.resourceType = Array.isArray(filter.resourceType)
            ? { in: filter.resourceType }
            : filter.resourceType;
        }
        if (filter.resourceId) {
          where.resourceId = filter.resourceId;
        }
        if (filter.startDate || filter.endDate) {
          where.startedAt = {};
          if (filter.startDate) {
            where.startedAt.gte = new Date(filter.startDate);
          }
          if (filter.endDate) {
            where.startedAt.lte = new Date(filter.endDate);
          }
        }
        if (filter.search) {
          where.OR = [
            { eventName: { contains: filter.search } },
            { description: { contains: filter.search } },
            { resourceName: { contains: filter.search } },
          ];
        }
      }

      // Apply sorting
      const orderBy: any = {};
      if (sort) {
        orderBy[sort.field] = sort.order;
      } else {
        // Default sort by startedAt descending (newest first)
        orderBy.startedAt = 'desc';
      }

      // Get total count
      const totalCount = await this.prisma.userEvent.count({ where });

      // Get events
      const events = await this.prisma.userEvent.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      });

      this.logger.debug(
        {
          filter,
          sort,
          limit,
          offset,
          totalCount,
          returnedCount: events.length,
        },
        'Listed user events',
      );

      return {
        events: events.map((e) => this.toEventInfo(e)),
        totalCount,
      };
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          filter,
        },
        'Failed to list user events',
      );
      throw error;
    }
  }

  /**
   * Delete a user event by ID
   */
  async deleteEvent(eventId: string): Promise<void> {
    try {
      this.logger.debug({ eventId }, 'Deleting user event');

      await this.prisma.userEvent.delete({
        where: { id: eventId },
      });

      this.logger.info({ eventId }, 'User event deleted successfully');
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          eventId,
        },
        'Failed to delete user event',
      );
      throw error;
    }
  }

  /**
   * Delete old user events based on retention policy
   */
  async cleanupExpiredEvents(retentionDays: number): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      this.logger.info(
        {
          cutoffDate: cutoffDate.toISOString(),
          retentionDays,
        },
        'Cleaning up expired user events',
      );

      // Delete events that are older than retention period OR have expired
      const result = await this.prisma.userEvent.deleteMany({
        where: {
          OR: [
            { startedAt: { lt: cutoffDate } },
            { expiresAt: { not: null, lt: new Date() } },
          ],
        },
      });

      this.logger.info(
        {
          deletedCount: result.count,
          cutoffDate: cutoffDate.toISOString(),
          retentionDays,
        },
        'Cleaned up expired user events',
      );

      return result.count;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          retentionDays,
        },
        'Failed to cleanup expired user events',
      );
      throw error;
    }
  }

  /**
   * Get statistics about user events
   */
  async getStatistics(): Promise<{
    totalEvents: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    byCategory: Record<string, number>;
    recentFailures: number;
    averageDuration: number | null;
  }> {
    try {
      const totalEvents = await this.prisma.userEvent.count();

      // Get counts by status
      const statusCounts = await this.prisma.userEvent.groupBy({
        by: ['status'],
        _count: true,
      });
      const byStatus: Record<string, number> = {};
      statusCounts.forEach((row) => {
        byStatus[row.status] = row._count;
      });

      // Get counts by type
      const typeCounts = await this.prisma.userEvent.groupBy({
        by: ['eventType'],
        _count: true,
      });
      const byType: Record<string, number> = {};
      typeCounts.forEach((row) => {
        byType[row.eventType] = row._count;
      });

      // Get counts by category
      const categoryCounts = await this.prisma.userEvent.groupBy({
        by: ['eventCategory'],
        _count: true,
      });
      const byCategory: Record<string, number> = {};
      categoryCounts.forEach((row) => {
        byCategory[row.eventCategory] = row._count;
      });

      // Get recent failures (last 24 hours)
      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
      const recentFailures = await this.prisma.userEvent.count({
        where: {
          status: 'failed',
          startedAt: { gte: twentyFourHoursAgo },
        },
      });

      // Calculate average duration for completed events
      const completedEvents = await this.prisma.userEvent.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          durationMs: { not: null },
        },
        select: { durationMs: true },
      });

      let averageDuration: number | null = null;
      if (completedEvents.length > 0) {
        const sum = completedEvents.reduce(
          (acc, e) => acc + (e.durationMs || 0),
          0,
        );
        averageDuration = Math.round(sum / completedEvents.length);
      }

      return {
        totalEvents,
        byStatus,
        byType,
        byCategory,
        recentFailures,
        averageDuration,
      };
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to get user event statistics',
      );
      throw error;
    }
  }

  /**
   * Convert database UserEvent to API-friendly UserEventInfo
   */
  private toEventInfo(
    event: UserEvent & {
      user?: { id: string; email: string; name: string | null } | null;
    },
  ): UserEventInfo {
    return {
      id: event.id,
      eventType: event.eventType,
      eventCategory: event.eventCategory,
      eventName: event.eventName,
      userId: event.userId,
      triggeredBy: event.triggeredBy,
      status: event.status,
      progress: event.progress,
      startedAt: event.startedAt.toISOString(),
      completedAt: event.completedAt ? event.completedAt.toISOString() : null,
      durationMs: event.durationMs,
      resourceId: event.resourceId,
      resourceType: event.resourceType,
      resourceName: event.resourceName,
      description: event.description,
      metadata: event.metadata ? JSON.parse(event.metadata) : null,
      resultSummary: event.resultSummary,
      errorMessage: event.errorMessage,
      errorDetails: event.errorDetails
        ? JSON.parse(event.errorDetails)
        : null,
      logs: event.logs,
      expiresAt: event.expiresAt ? event.expiresAt.toISOString() : null,
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
      user: event.user || undefined,
    };
  }
}
