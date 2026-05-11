import type { PrismaClient } from '../../generated/prisma/client';
import type { JobPoolConfig } from '@mini-infra/types';
import type { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { NatsBus } from '../nats/nats-bus';
import {
  jobPoolTriggerRequestSchema,
  type JobPoolTriggerRequest,
  type JobPoolTriggerReply,
} from '../nats/payload-schemas';
import { runJobPool } from './job-pool-spawner';

const log = getLogger('stacks', 'job-pool-nats-registry');

/** A registered subscription, keyed by subject. */
interface NatsRegistryEntry {
  /** Owning stack + service so we can route fired requests through `runJobPool`. */
  stackId: string;
  serviceName: string;
  /** Operator-facing trigger name from `JobPoolTrigger.name`. */
  triggerName: string;
  /** Cancel handle returned by `NatsBus.respond`. */
  cancel: () => void;
}

/**
 * Singleton registry that owns every `nats-request`-trigger subscription
 * across every applied JobPool service. Mirrors `JobPoolCronRegistry`:
 *
 *   - `loadAll()` rebuilds the live subscription set from `StackService`
 *     rows on server boot.
 *   - `refresh(stackId)` diffs declared subjects against current
 *     subscriptions and unsubscribes-then-subscribes.
 *
 * Ordering invariant (plan §7): within a refresh cycle, removals run before
 * adds so two handlers never race on the same subject. The plan calls this
 * out explicitly as a v1 constraint that needs unit-test coverage.
 *
 * The registry deliberately keys by **subject**, not by trigger name —
 * NATS subscriptions are subject-scoped, and the user-declared trigger
 * subject is what the bus actually routes against. Two triggers on the
 * same subject (within or across pools) would clobber each other; the
 * apply-time schema validator already rejects same-subject collisions
 * inside one pool, but cross-stack collisions slip through the schema
 * and surface here as "last writer wins" — that's by design for v1.
 */
export class JobPoolNatsRegistry {
  private static instance: JobPoolNatsRegistry | null = null;

  private readonly entries = new Map<string, NatsRegistryEntry>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly resolveDockerExecutor: () => Promise<DockerExecutorService>,
  ) {}

  static setInstance(instance: JobPoolNatsRegistry | null): void {
    JobPoolNatsRegistry.instance = instance;
  }

  static getInstance(): JobPoolNatsRegistry | null {
    return JobPoolNatsRegistry.instance;
  }

  /** Number of live subscriptions across every JobPool. Test/observability hook. */
  size(): number {
    return this.entries.size;
  }

  /** Snapshot of the subscribed subjects (test/observability hook). */
  registeredSubjects(): string[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * Load every JobPool's `nats-request` triggers from the DB and subscribe.
   * Idempotent; call from `server.ts` on boot.
   */
  async loadAll(): Promise<void> {
    const services = await this.prisma.stackService.findMany({
      where: { serviceType: 'JobPool' },
      select: { stackId: true },
      distinct: ['stackId'],
    });
    log.info({ stackCount: services.length }, 'JobPoolNatsRegistry: loading nats-request triggers from DB');
    for (const { stackId } of services) {
      try {
        await this.refresh(stackId);
      } catch (err) {
        log.error(
          { stackId, err: err instanceof Error ? err.message : String(err) },
          'JobPoolNatsRegistry: failed to load nats-request triggers for stack (continuing)',
        );
      }
    }
    log.info({ total: this.entries.size }, 'JobPoolNatsRegistry: loaded');
  }

  /**
   * Re-reconcile the `nats-request` subscriptions for a single stack against
   * the current DB state. Removals run before adds.
   */
  async refresh(stackId: string): Promise<void> {
    const services = await this.prisma.stackService.findMany({
      where: { stackId, serviceType: 'JobPool' },
    });

    interface Desired {
      subject: string;
      stackId: string;
      serviceName: string;
      triggerName: string;
    }
    const desired: Desired[] = [];
    for (const svc of services) {
      const cfg = svc.jobPoolConfig as unknown as JobPoolConfig | null;
      if (!cfg) continue;
      for (const trigger of cfg.triggers ?? []) {
        if (trigger.kind !== 'nats-request') continue;
        desired.push({
          subject: trigger.subject,
          stackId,
          serviceName: svc.serviceName,
          triggerName: trigger.name,
        });
      }
    }
    const desiredBySubject = new Map(desired.map((d) => [d.subject, d]));

    // Phase 1: removals — every entry that *was* owned by this stack and is
    // no longer present in the desired set, or whose ownership changed
    // (different service / triggerName on the same subject — same-subject
    // rebinds get a clean tear-down before the new subscribe).
    const removals: string[] = [];
    for (const [subject, entry] of this.entries) {
      if (entry.stackId !== stackId) continue;
      const want = desiredBySubject.get(subject);
      if (!want) {
        removals.push(subject);
        continue;
      }
      if (want.serviceName !== entry.serviceName || want.triggerName !== entry.triggerName) {
        removals.push(subject);
      }
    }
    for (const subject of removals) {
      this.unsubscribe(subject);
    }

    // Phase 2: adds — every desired subject not already subscribed.
    for (const want of desired) {
      if (this.entries.has(want.subject)) continue;
      this.subscribe(want);
    }

    log.info(
      {
        stackId,
        desired: desired.length,
        registered: this.entries.size,
        removed: removals.length,
      },
      'JobPoolNatsRegistry.refresh completed',
    );
  }

  /**
   * Remove every subscription associated with `stackId`. Useful for explicit
   * stack-destroy paths that bypass the apply handler.
   */
  removeStack(stackId: string): void {
    const subjects: string[] = [];
    for (const [subject, entry] of this.entries) {
      if (entry.stackId === stackId) subjects.push(subject);
    }
    for (const subject of subjects) {
      this.unsubscribe(subject);
    }
    if (subjects.length > 0) {
      log.info({ stackId, removed: subjects.length }, 'JobPoolNatsRegistry: removed all subscriptions for stack');
    }
  }

  /** Stop every subscription. Call on server shutdown. */
  stopAll(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.cancel();
      } catch {
        // best-effort
      }
    }
    this.entries.clear();
    log.info('JobPoolNatsRegistry: stopped all subscriptions');
  }

  // ----- internals --------------------------------------------------------

  private subscribe(want: {
    subject: string;
    stackId: string;
    serviceName: string;
    triggerName: string;
  }): void {
    const bus = NatsBus.getInstance();
    // The trigger subject is user-declared (e.g. `mini-infra.backup.run`) —
    // the bus's per-subject Zod validator can't bind a schema to an
    // arbitrary user subject, so we pass `unchecked: true` and validate
    // inline against the trigger envelope schema.
    const cancel = bus.respond<unknown, JobPoolTriggerReply>(
      want.subject,
      async (req): Promise<JobPoolTriggerReply> => {
        // Tolerate both `{}` and "no body" — `nats request <subject> ''`
        // delivers an empty body which decodes to `null`. Treat null /
        // undefined as `{}` so a trigger with no payload still spawns.
        let payload: JobPoolTriggerRequest | undefined;
        if (req !== null && req !== undefined) {
          const parsed = jobPoolTriggerRequestSchema.safeParse(req);
          if (!parsed.success) {
            log.warn(
              {
                stackId: want.stackId,
                serviceName: want.serviceName,
                triggerName: want.triggerName,
                subject: want.subject,
                issue: parsed.error.issues[0]?.message,
              },
              'JobPoolNatsRegistry: rejected malformed request body',
            );
            return { error: parsed.error.issues[0]?.message ?? 'invalid request body' };
          }
          payload = parsed.data;
        }

        try {
          const dockerExecutor = await this.resolveDockerExecutor();
          const result = await runJobPool(this.prisma, dockerExecutor, {
            stackId: want.stackId,
            serviceName: want.serviceName,
            trigger: { kind: 'nats-request', name: want.triggerName },
            payload,
          });
          if (result.ok) {
            return { runId: result.runId };
          }
          if (result.reason === 'concurrency_cap') {
            return {
              error: 'concurrency_cap_reached',
              maxConcurrent: result.maxConcurrent,
            };
          }
          if (result.reason === 'service_not_found' || result.reason === 'stack_not_found') {
            // Subscription is stale relative to DB — the apply handler must
            // have not run yet, or the stack was destroyed mid-flight.
            return { error: result.reason };
          }
          if (result.reason === 'stack_in_error') {
            return { error: 'stack_in_error' };
          }
          return { error: result.message ?? 'spawn_failed' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            {
              stackId: want.stackId,
              serviceName: want.serviceName,
              triggerName: want.triggerName,
              subject: want.subject,
              err: msg,
            },
            'JobPoolNatsRegistry: handler threw',
          );
          return { error: msg };
        }
      },
      { unchecked: true },
    );

    this.entries.set(want.subject, {
      stackId: want.stackId,
      serviceName: want.serviceName,
      triggerName: want.triggerName,
      cancel,
    });
    log.info(
      {
        stackId: want.stackId,
        serviceName: want.serviceName,
        triggerName: want.triggerName,
        subject: want.subject,
      },
      'JobPoolNatsRegistry: subscribed nats-request trigger',
    );
  }

  private unsubscribe(subject: string): void {
    const entry = this.entries.get(subject);
    if (!entry) return;
    try {
      entry.cancel();
    } catch (err) {
      log.warn(
        { subject, err: err instanceof Error ? err.message : String(err) },
        'JobPoolNatsRegistry: cancel threw (continuing)',
      );
    }
    this.entries.delete(subject);
    log.info(
      {
        stackId: entry.stackId,
        serviceName: entry.serviceName,
        triggerName: entry.triggerName,
        subject,
      },
      'JobPoolNatsRegistry: unsubscribed nats-request trigger',
    );
  }
}
