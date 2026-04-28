import type { PrismaClient } from '../../generated/prisma/client';
import { getLogger } from '../../lib/logger-factory';
import type { EgressArchivedReason } from '@mini-infra/types';

const log = getLogger('stacks', 'egress-policy-lifecycle');

/**
 * Manages the lifecycle of EgressPolicy rows in lockstep with Stack and
 * Environment lifecycle events.
 *
 * All methods wrap in try/catch and log errors rather than throwing — a
 * failure to manage egress policy state must never break stack/env operations.
 */
export class EgressPolicyLifecycleService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Called after a new Stack row is created.
   *
   * If the stack is env-scoped, upserts a default EgressPolicy:
   *   mode=detect, defaultAction=allow, empty rules, snapshots seeded from
   *   the stack + env.
   *
   * If a non-archived policy already exists for this stack (e.g. retry), only
   * the snapshot fields and updatedBy are refreshed — mode/defaultAction/rules
   * are left untouched (they may have been edited by the operator).
   *
   * No-op for host-scoped stacks (environmentId === null).
   */
  async ensureDefaultPolicy(stackId: string, userId: string | null): Promise<void> {
    try {
      const stack = await this.prisma.stack.findUnique({
        where: { id: stackId },
        include: { environment: true },
      });

      if (!stack) {
        log.warn({ stackId }, 'ensureDefaultPolicy: stack not found, skipping');
        return;
      }

      // Host-scoped stacks are not firewalled in v1
      if (!stack.environmentId || !stack.environment) {
        log.debug({ stackId }, 'ensureDefaultPolicy: host-scoped stack, skipping');
        return;
      }

      const stackNameSnapshot = stack.name;
      const environmentNameSnapshot = stack.environment.name;

      // Check for an existing non-archived policy for this stack
      const existing = await this.prisma.egressPolicy.findFirst({
        where: { stackId, archivedAt: null },
      });

      if (existing) {
        // Policy exists — only refresh snapshots and updatedBy
        await this.prisma.egressPolicy.update({
          where: { id: existing.id },
          data: {
            stackNameSnapshot,
            environmentNameSnapshot,
            updatedBy: userId,
          },
        });
        log.debug(
          { stackId, policyId: existing.id },
          'ensureDefaultPolicy: refreshed snapshots on existing policy',
        );
        return;
      }

      // No non-archived policy — create a fresh default policy
      const policy = await this.prisma.egressPolicy.create({
        data: {
          stackId,
          stackNameSnapshot,
          environmentId: stack.environmentId,
          environmentNameSnapshot,
          mode: 'detect',
          defaultAction: 'allow',
          createdBy: userId,
          updatedBy: userId,
        },
      });

      log.info(
        { stackId, policyId: policy.id, environmentId: stack.environmentId },
        'ensureDefaultPolicy: created default egress policy',
      );
    } catch (err) {
      log.error(
        { err, stackId },
        'ensureDefaultPolicy: failed to ensure default egress policy — continuing without it',
      );
    }
  }

  /**
   * Set archivedAt on the non-archived policy for this stack.
   * Idempotent — no-op if already archived or no policy exists.
   */
  async archiveForStack(stackId: string, userId: string | null): Promise<void> {
    try {
      const result = await this.prisma.egressPolicy.updateMany({
        where: { stackId, archivedAt: null },
        data: {
          archivedAt: new Date(),
          archivedReason: 'stack-deleted' satisfies EgressArchivedReason,
          updatedBy: userId,
        },
      });

      if (result.count > 0) {
        log.info(
          { stackId, updatedCount: result.count },
          'archiveForStack: archived egress policies for stack',
        );
      }
    } catch (err) {
      log.error(
        { err, stackId },
        'archiveForStack: failed to archive egress policy — continuing',
      );
    }
  }

  /**
   * Set archivedAt on every non-archived policy in the environment.
   * Idempotent — skips already-archived rows.
   *
   * This is the safety-net call during env delete: it catches policies whose
   * stack rows may already have been NULLed by the stack-delete hook or by
   * the Prisma onDelete: SetNull cascade.
   */
  async archiveForEnvironment(environmentId: string, userId: string | null): Promise<void> {
    try {
      const result = await this.prisma.egressPolicy.updateMany({
        where: { environmentId, archivedAt: null },
        data: {
          archivedAt: new Date(),
          archivedReason: 'environment-deleted' satisfies EgressArchivedReason,
          updatedBy: userId,
        },
      });

      if (result.count > 0) {
        log.info(
          { environmentId, updatedCount: result.count },
          'archiveForEnvironment: archived egress policies for environment',
        );
      }
    } catch (err) {
      log.error(
        { err, environmentId },
        'archiveForEnvironment: failed to archive egress policies — continuing',
      );
    }
  }

  /**
   * Refresh stackNameSnapshot for the stack's non-archived policy.
   * No-op if no policy exists for the stack.
   */
  async refreshStackNameSnapshot(stackId: string): Promise<void> {
    try {
      const stack = await this.prisma.stack.findUnique({
        where: { id: stackId },
        select: { name: true },
      });

      if (!stack) {
        log.debug({ stackId }, 'refreshStackNameSnapshot: stack not found, skipping');
        return;
      }

      const result = await this.prisma.egressPolicy.updateMany({
        where: { stackId, archivedAt: null },
        data: { stackNameSnapshot: stack.name },
      });

      if (result.count > 0) {
        log.debug(
          { stackId, stackName: stack.name },
          'refreshStackNameSnapshot: updated stack name snapshot',
        );
      }
    } catch (err) {
      log.error(
        { err, stackId },
        'refreshStackNameSnapshot: failed to refresh stack name snapshot — continuing',
      );
    }
  }

  /**
   * Bulk-refresh environmentNameSnapshot for all non-archived policies in the env.
   * No-op if no policies exist for the environment.
   */
  async refreshEnvironmentNameSnapshot(environmentId: string): Promise<void> {
    try {
      const environment = await this.prisma.environment.findUnique({
        where: { id: environmentId },
        select: { name: true },
      });

      if (!environment) {
        log.debug(
          { environmentId },
          'refreshEnvironmentNameSnapshot: environment not found, skipping',
        );
        return;
      }

      const result = await this.prisma.egressPolicy.updateMany({
        where: { environmentId, archivedAt: null },
        data: { environmentNameSnapshot: environment.name },
      });

      if (result.count > 0) {
        log.debug(
          { environmentId, environmentName: environment.name },
          'refreshEnvironmentNameSnapshot: updated environment name snapshot',
        );
      }
    } catch (err) {
      log.error(
        { err, environmentId },
        'refreshEnvironmentNameSnapshot: failed to refresh environment name snapshot — continuing',
      );
    }
  }
}
