import { JobPoolSubject } from '@mini-infra/types';
import { getLogger } from '../../lib/logger-factory';
import { NatsBus } from '../nats/nats-bus';
import {
  jobPoolRunCompletedSchema,
  jobPoolRunFailedSchema,
  jobPoolRunSkippedSchema,
  type JobPoolRunCompleted,
  type JobPoolRunFailed,
  type JobPoolRunSkipped,
} from '../nats/payload-schemas';
import {
  emitJobPoolRunCompleted,
  emitJobPoolRunFailed,
  emitJobPoolRunSkipped,
} from './pool-socket-emitter';

const log = getLogger('stacks', 'job-pool-history-publisher');

/**
 * Publish a JobPool run lifecycle event onto the per-pool subject *and* fan
 * the same payload out over Socket.IO. The two surfaces are kept in lockstep
 * so any UI subscriber (live page) sees the same shape as any
 * server-restart replay consumer reading from the per-pool JetStream
 * history stream.
 *
 * Validation is inline against the Zod schemas exported from
 * `payload-schemas.ts` — the bus's static-subject lookup doesn't match
 * per-pool parameterised subjects, so callers pass `unchecked: true` here
 * and the schema is applied client-side instead. A validation miss is
 * logged but doesn't throw — the publisher path must not break the exit
 * watcher's transition pass.
 *
 * Each call performs at most one JetStream publish and one Socket.IO emit;
 * either failure is logged and swallowed so the caller's DB transition is
 * never blocked.
 */

export async function publishJobPoolCompleted(payload: JobPoolRunCompleted): Promise<void> {
  const parsed = jobPoolRunCompletedSchema.safeParse(payload);
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues.slice(0, 3), runId: payload.runId },
      'JobPool completed payload failed validation — skipping publish',
    );
    return;
  }
  const subject = JobPoolSubject.completed(payload.stackId, payload.serviceName);
  try {
    await NatsBus.getInstance().jetstream.publish(subject, parsed.data, { unchecked: true });
  } catch (err) {
    log.warn(
      {
        runId: payload.runId,
        stackId: payload.stackId,
        serviceName: payload.serviceName,
        err: err instanceof Error ? err.message : String(err),
      },
      'JobPool completed JetStream publish failed (Socket.IO fan-out still attempted)',
    );
  }
  emitJobPoolRunCompleted(parsed.data);
}

export async function publishJobPoolFailed(payload: JobPoolRunFailed): Promise<void> {
  const parsed = jobPoolRunFailedSchema.safeParse(payload);
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues.slice(0, 3), runId: payload.runId },
      'JobPool failed payload failed validation — skipping publish',
    );
    return;
  }
  const subject = JobPoolSubject.failed(payload.stackId, payload.serviceName);
  try {
    await NatsBus.getInstance().jetstream.publish(subject, parsed.data, { unchecked: true });
  } catch (err) {
    log.warn(
      {
        runId: payload.runId,
        stackId: payload.stackId,
        serviceName: payload.serviceName,
        err: err instanceof Error ? err.message : String(err),
      },
      'JobPool failed JetStream publish failed (Socket.IO fan-out still attempted)',
    );
  }
  emitJobPoolRunFailed(parsed.data);
}

/**
 * `run-skipped` is plain pub/sub — observability for cap-hit scheduled runs
 * — and not durable on JetStream. A missed message after a server restart
 * is acceptable; the cap-hit row was never created in the DB.
 */
export async function publishJobPoolRunSkipped(payload: JobPoolRunSkipped): Promise<void> {
  const parsed = jobPoolRunSkippedSchema.safeParse(payload);
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues.slice(0, 3), triggerName: payload.triggerName },
      'JobPool run-skipped payload failed validation — skipping publish',
    );
    return;
  }
  const subject = JobPoolSubject.runSkipped(payload.stackId, payload.serviceName);
  try {
    await NatsBus.getInstance().publish(subject, parsed.data, { unchecked: true });
  } catch (err) {
    log.warn(
      {
        stackId: payload.stackId,
        serviceName: payload.serviceName,
        triggerName: payload.triggerName,
        err: err instanceof Error ? err.message : String(err),
      },
      'JobPool run-skipped NATS publish failed (Socket.IO fan-out still attempted)',
    );
  }
  emitJobPoolRunSkipped(parsed.data);
}
