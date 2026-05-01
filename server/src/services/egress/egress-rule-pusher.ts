/**
 * EgressRulePusher
 *
 * Keeps each environment's egress-gateway in sync with the DB's EgressPolicy
 * + EgressRule state.
 *
 * - pushForEnvironment(envId): loads all non-archived policies for the env,
 *   builds a full RulesSnapshotRequest, and POSTs to the gateway.
 * - pushForStack(stackId): convenience — resolves the env and delegates.
 * - pushForPolicy(policyId): convenience — resolves the env and delegates.
 * - syncAll(): called on start() — pushes all envs that have an egressGatewayIp.
 * - On failure: retries once after 1 s; on second failure gives up until the
 *   next mutation triggers a fresh push.
 * - Per-env version counter: in-memory monotonic, incremented on every attempt
 *   (rolled back on second failure — same pattern as EgressContainerMapPusher).
 * - Concurrency guard: if a push for an env is already in-flight, queues
 *   exactly one follow-up (does not pile up).
 * - On successful push: updates EgressPolicy.appliedVersion for all policies
 *   in the snapshot via a single updateMany.
 */

import type { PrismaClient } from '../../generated/prisma/client';
import { type StackPolicyEntry } from './egress-gateway-client';
import { pushRulesViaNats, readGatewayHealth } from './egress-gateway-transport';
import { getLogger } from '../../lib/logger-factory';
import { emitEgressGatewayHealth } from './egress-socket-emitter';

const log = getLogger('stacks', 'egress-rule-pusher');

const RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Shapes we query from Prisma
// ---------------------------------------------------------------------------

interface RuleRow {
  id: string;
  pattern: string;
  action: string;
  targets: unknown; // JSON field — parsed as string[]
}

interface PolicyRow {
  id: string;
  stackId: string | null;
  mode: string;
  defaultAction: string;
  version: number;
  rules: RuleRow[];
}

interface EnvRow {
  id: string;
  name: string;
  egressGatewayIp: string;
}

// ---------------------------------------------------------------------------
// Per-environment push state
// ---------------------------------------------------------------------------

interface EnvPushState {
  version: number;
  /** true while a push attempt is in-flight */
  inFlight: boolean;
  /** true if another push was requested while one was in-flight */
  pendingFollowUp: boolean;
}

// ---------------------------------------------------------------------------
// EgressRulePusher
// ---------------------------------------------------------------------------

export class EgressRulePusher {
  private readonly states = new Map<string, EnvPushState>();
  private stopped = false;

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Call once at startup: performs an initial syncAll().
   */
  async start(): Promise<void> {
    log.info('EgressRulePusher starting');
    await this.syncAll();
    log.info('EgressRulePusher started');
  }

  /**
   * Graceful teardown. After stop(), in-flight pushes still complete but no
   * new pushes are initiated.
   */
  stop(): void {
    this.stopped = true;
    log.info('EgressRulePusher stopped');
  }

  /**
   * Push the full policy+rules snapshot for one environment.
   *
   * Loads all non-archived EgressPolicy rows whose environmentId === envId,
   * builds the snapshot, and POSTs to that env's gateway.
   *
   * If a push for this env is already in-flight, queues exactly one
   * follow-up push (excess calls are coalesced).
   */
  async pushForEnvironment(envId: string): Promise<void> {
    if (this.stopped) return;

    // Coalesce concurrent calls — set inFlight synchronously before the first
    // await so that concurrent callers see the flag immediately.
    const state = this._getOrCreateState(envId);
    if (state.inFlight) {
      state.pendingFollowUp = true;
      return;
    }
    state.inFlight = true;

    try {
      // Fetch the env row — we need egressGatewayIp
      let env: EnvRow | null;
      try {
        const row = await this.prisma.environment.findUnique({
          where: { id: envId },
          select: { id: true, name: true, egressGatewayIp: true },
        });
        if (!row || !row.egressGatewayIp) {
          log.info({ envId }, 'pushForEnvironment: env has no egressGatewayIp — skipping');
          return;
        }
        env = row as EnvRow;
      } catch (err) {
        log.warn({ err, envId }, 'pushForEnvironment: failed to fetch env row — skipping');
        return;
      }

      await this._pushEnvWithRetry(env, state);
    } finally {
      state.inFlight = false;
      // If another push was queued while we were in-flight, run it now.
      if (state.pendingFollowUp && !this.stopped) {
        state.pendingFollowUp = false;
        void this.pushForEnvironment(envId);
      }
    }
  }

  /**
   * Convenience: given a stackId, look up its environmentId and push.
   * Used by API route handlers after a rule or policy mutation.
   */
  async pushForStack(stackId: string): Promise<void> {
    let envId: string | null | undefined;
    try {
      const stack = await this.prisma.stack.findUnique({
        where: { id: stackId },
        select: { environmentId: true },
      });
      envId = stack?.environmentId;
    } catch (err) {
      log.warn({ err, stackId }, 'pushForStack: failed to fetch stack — skipping');
      return;
    }

    if (!envId) {
      log.debug({ stackId }, 'pushForStack: stack has no environmentId (host-scoped) — skipping');
      return;
    }

    return this.pushForEnvironment(envId);
  }

  /**
   * Convenience: given a policyId, look up its environmentId and push.
   * Used by API route handlers after a rule or policy mutation.
   */
  async pushForPolicy(policyId: string): Promise<void> {
    let envId: string | null | undefined;
    try {
      const policy = await this.prisma.egressPolicy.findUnique({
        where: { id: policyId },
        select: { environmentId: true },
      });
      envId = policy?.environmentId;
    } catch (err) {
      log.warn({ err, policyId }, 'pushForPolicy: failed to fetch policy — skipping');
      return;
    }

    if (!envId) {
      log.debug({ policyId }, 'pushForPolicy: policy has no environmentId — skipping');
      return;
    }

    return this.pushForEnvironment(envId);
  }

  /**
   * Initial sync: push rules to every env that has an egressGatewayIp.
   * Sequential — there are typically few envs and we don't want to hammer
   * the gateways in parallel on startup.
   */
  async syncAll(): Promise<void> {
    let envs: EnvRow[];
    try {
      envs = await this._getEnvsWithGateway();
    } catch (err) {
      log.warn({ err }, 'syncAll: failed to fetch envs — skipping initial rule sync');
      return;
    }

    log.info({ count: envs.length }, 'syncAll: pushing rules to all envs');

    for (const env of envs) {
      if (this.stopped) break;
      const state = this._getOrCreateState(env.id);
      state.inFlight = true;
      try {
        await this._pushEnvWithRetry(env, state);
      } finally {
        state.inFlight = false;
        if (state.pendingFollowUp && !this.stopped) {
          state.pendingFollowUp = false;
          void this.pushForEnvironment(env.id);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _getOrCreateState(envId: string): EnvPushState {
    let state = this.states.get(envId);
    if (!state) {
      state = { version: 0, inFlight: false, pendingFollowUp: false };
      this.states.set(envId, state);
    }
    return state;
  }

  /**
   * Attempt to push rules for an env, with one retry on failure.
   *
   * Increments the version counter before each attempt. On second failure,
   * rolls back the version bump so the next push increments from a sane
   * baseline (mirrors EgressContainerMapPusher behaviour).
   */
  private async _pushEnvWithRetry(env: EnvRow, state: EnvPushState): Promise<void> {
    const attempt = async (): Promise<void> => {
      const { snapshot, policyIds } = await this._buildSnapshot(env.id);
      state.version += 1;

      // Push via NATS request/reply on `mini-infra.egress.gw.rules.apply.<envId>`.
      // The gateway's reply is Zod-validated by NatsBus on the way back; a
      // non-accepted reply throws (see EgressGatewayTransportError).
      const result = await pushRulesViaNats(env.id, {
        version: state.version,
        stackPolicies: snapshot,
      });

      // On success: stamp appliedVersion for all policies in this snapshot
      if (policyIds.length > 0) {
        await this.prisma.egressPolicy.updateMany({
          where: { id: { in: policyIds } },
          data: { appliedVersion: state.version },
        });
      }

      log.info(
        {
          envId: env.id,
          envName: env.name,
          version: result.version,
          ruleCount: result.ruleCount,
          stackCount: result.stackCount,
        },
        'Rules snapshot pushed to gateway via NATS',
      );

      // Read the gateway's most recent heartbeat (KV bucket) so the UI
      // emitter can attribute container-map state correctly. Best-effort —
      // if the bucket isn't ready yet, we still emit success for rules.
      const health = await readGatewayHealth(env.id);

      // Emit gateway health — success
      emitEgressGatewayHealth({
        environmentId: env.id,
        gatewayIp: env.egressGatewayIp,
        ok: true,
        rulesVersion: state.version,
        appliedRulesVersion: state.version,
        containerMapVersion: health?.containerMapVersion ?? 0,
        appliedContainerMapVersion: health?.containerMapVersion ?? null,
        upstream: {
          servers: [],
          lastSuccessAt: new Date().toISOString(),
          lastFailureAt: null,
        },
      });
    };

    try {
      await attempt();
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          envId: env.id,
          envName: env.name,
        },
        'Rule push failed — retrying once',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      try {
        await attempt();
      } catch (err2) {
        const errMsg = err2 instanceof Error ? err2.message : String(err2);
        log.warn(
          {
            err: errMsg,
            envId: env.id,
            envName: env.name,
          },
          'Rule push failed on retry — giving up until next mutation',
        );
        // Roll back the version bump so the next push increments from a sane baseline
        state.version -= 1;

        // Emit gateway health — failure
        emitEgressGatewayHealth({
          environmentId: env.id,
          gatewayIp: env.egressGatewayIp,
          ok: false,
          rulesVersion: state.version,
          appliedRulesVersion: null,
          containerMapVersion: 0,
          appliedContainerMapVersion: null,
          upstream: {
            servers: [],
            lastSuccessAt: null,
            lastFailureAt: new Date().toISOString(),
          },
          errorMessage: errMsg,
        });
      }
    }
  }

  /**
   * Query all non-archived EgressPolicy rows for the environment (with rules)
   * and build the RulesSnapshotRequest stackPolicies map.
   *
   * Returns both the snapshot map and the list of policy IDs included, so the
   * caller can update appliedVersion.
   */
  private async _buildSnapshot(
    envId: string,
  ): Promise<{ snapshot: Record<string, StackPolicyEntry>; policyIds: string[] }> {
    const policies = await this.prisma.egressPolicy.findMany({
      where: { environmentId: envId, archivedAt: null },
      select: {
        id: true,
        stackId: true,
        mode: true,
        defaultAction: true,
        version: true,
        rules: {
          select: {
            id: true,
            pattern: true,
            action: true,
            targets: true,
          },
        },
      },
    }) as PolicyRow[];

    const snapshot: Record<string, StackPolicyEntry> = {};
    const policyIds: string[] = [];

    for (const policy of policies) {
      // Policies without a stackId (stack deleted via SetNull) still exist for
      // audit purposes but have no stack to associate with — skip them.
      if (!policy.stackId) continue;

      policyIds.push(policy.id);

      const rules = policy.rules.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        action: r.action as 'allow' | 'block',
        targets: Array.isArray(r.targets) ? (r.targets as string[]) : [],
      }));

      snapshot[policy.stackId] = {
        mode: policy.mode as 'detect' | 'enforce',
        defaultAction: policy.defaultAction as 'allow' | 'block',
        rules,
      };
    }

    log.debug(
      { envId, stackCount: Object.keys(snapshot).length, policyCount: policies.length },
      'Built rules snapshot',
    );

    return { snapshot, policyIds };
  }

  private async _getEnvsWithGateway(): Promise<EnvRow[]> {
    const envs = await this.prisma.environment.findMany({
      where: { egressGatewayIp: { not: null } },
      select: { id: true, name: true, egressGatewayIp: true },
    });
    return envs.filter(
      (e): e is EnvRow => e.egressGatewayIp !== null && e.egressGatewayIp !== undefined,
    );
  }
}
