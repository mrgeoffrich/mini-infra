import type { PrismaClient } from '@prisma/client';
import { UserEventService } from '../user-events';
import { appLogger } from '../../lib/logger-factory';

const logger = appLogger();

type UpdatePatch = Parameters<UserEventService['updateEvent']>[1];
type CreateRequest = Parameters<UserEventService['createEvent']>[0];

/**
 * Thin wrapper around UserEventService for long-running stack operations.
 *
 * Every method swallows errors — an audit-log failure must never break the
 * underlying apply/update/destroy. The underlying event id is captured on
 * `begin()` and reused for all subsequent operations. All methods become
 * no-ops if the initial create failed.
 */
export class StackUserEvent {
  private readonly service: UserEventService;
  private eventId: string | undefined;

  constructor(prisma: PrismaClient) {
    this.service = new UserEventService(prisma);
  }

  async begin(req: CreateRequest, contextMessage: string): Promise<void> {
    try {
      const event = await this.service.createEvent(req);
      this.eventId = event.id;
    } catch (err) {
      logger.warn({ error: err }, contextMessage);
    }
  }

  get id(): string | undefined {
    return this.eventId;
  }

  async appendLogs(logs: string): Promise<void> {
    if (!this.eventId) return;
    try {
      await this.service.appendLogs(this.eventId, logs);
    } catch { /* never break the caller */ }
  }

  async updateProgress(progress: number): Promise<void> {
    if (!this.eventId) return;
    try {
      await this.service.updateEvent(this.eventId, { progress });
    } catch { /* never break the caller */ }
  }

  async update(patch: UpdatePatch): Promise<void> {
    if (!this.eventId) return;
    try {
      await this.service.updateEvent(this.eventId, patch);
    } catch { /* never break the caller */ }
  }

  /** Mark the event as failed with the error message + type. */
  async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const type = (error as Error)?.constructor?.name;
    await this.update({
      status: 'failed',
      errorMessage: message,
      errorDetails: { type, message },
    });
  }
}
