/**
 * Egress self-heal supervisor (Phase 4, §4.2 consumer / §5 Phase 4).
 *
 * After any NATS identity/credential rotation the egress agents loop forever
 * on `authorization violation` and never self-recover: their `NATS_CREDS` is
 * injected via `dynamicEnv` at container **create** time, the reconciler sees
 * the stacks as `synced` (so nothing recreates them), and the failure is only
 * visible out-of-band. Phase 3 made that state visible (`auth-failing`); this
 * supervisor makes the server *act* on it.
 *
 * It watches the egress NATS-client stacks — the host `egress-fw-agent` stack
 * and the per-environment `egress-gateway` stacks — and, when one is
 * `containerRunning: true` but persistently `auth-failed` beyond a dwell
 * threshold, **force-recreates** it via `reconciler.update(stackId, {
 * forceRecreate: true })`. That is the load-bearing correctness point: a plain
 * container *restart* reuses the stale baked-in creds and does NOT fix
 * `auth-failing`; only a force-recreate re-runs the `nats-creds` injector and
 * re-mints the credential. (Contrast `recycleManagedNatsContainer()` in
 * `stack-nats-revocation.ts`, whose restart is correct only for the NATS
 * *server*, which re-reads its config from Vault on boot.)
 *
 * Safety (this recreates PRODUCTION containers automatically):
 *   - acts ONLY on a *persistent* `auth-failed` state — it must hold past
 *     `dwellMs` (never a transient `reconnecting` / `disconnected` / unreachable
 *     blip, and never while the container isn't running);
 *   - enforces exponential backoff between attempts plus a hard per-stack
 *     `maxAttempts` cap so a systemic problem can't trigger a recreate storm;
 *   - respects `stackOperationLock` — never recreates a stack mid-operation;
 *   - is gated by a feature flag (`egress-fw-agent.auto_remediation`, default
 *     ON) checked before any action;
 *   - resets a stack's state the moment it recovers to `connected`;
 *   - audits every recreate attempt and every cap-reached stop as a `UserEvent`.
 *
 * The state-machine core (`EgressSelfHealSupervisor`) is decoupled from all I/O
 * via injectable deps so it is unit-testable with a fake clock; the production
 * wiring below builds the real deps (probe → recreate → flag → audit).
 */

import type { PrismaClient } from "../../generated/prisma/client";
import type { EgressAgentConnState } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import DockerService from "../docker";
import { UserEventService } from "../user-events/user-event-service";
import { buildStackOperationServices } from "../stacks/stack-operation-context";
import { stackOperationLock } from "../stacks/operation-lock";
import {
  emitStackApplyServiceResult,
  emitStackApplyCompleted,
  emitStackApplyFailed,
} from "../stacks/stack-socket-emitter";
import { findFwAgent, getFwAgentConnState, getFwAgentConfig } from "./fw-agent-sidecar";
import { scrapeGatewayConnState } from "./agent-health-scraper";

const log = getLogger("stacks", "egress-self-heal-supervisor");

export type EgressStackKind = "fw-agent" | "gateway";

/** One egress NATS-client stack plus its current health signal for a tick. */
export interface EgressStackHealthProbe {
  stackId: string;
  stackName: string;
  kind: EgressStackKind;
  /** Environment id for gateways; null for the host fw-agent stack. */
  environmentId: string | null;
  /** Whether the stack's managed container is currently running. */
  containerRunning: boolean;
  /**
   * The out-of-band NATS connection state (Phase 3, §4.2). `null` means the
   * agent's `/healthz` wasn't reachable this probe — treated as "not
   * auth-failing" (never a trigger).
   */
  connState: EgressAgentConnState | null;
}

/** Tunables. See the file header for the safety rationale behind the defaults. */
export interface SelfHealConfig {
  /** How often the supervisor evaluates every egress stack. */
  tickIntervalMs: number;
  /** `auth-failed` must hold continuously for at least this long before the first recreate. */
  dwellMs: number;
  /** Backoff window after the 1st attempt; doubles each subsequent attempt. */
  baseBackoffMs: number;
  /** Upper bound on the backoff window. */
  maxBackoffMs: number;
  /** Hard cap on recreate attempts per stack before auto-remediation gives up. */
  maxAttempts: number;
}

/**
 * Defaults chosen conservatively (the plan defers these to implementation):
 *   - 15 s tick — fine granularity without hammering Docker/NATS.
 *   - 30 s dwell — a real rotation's `auth-failed` never self-resolves (creds
 *     are baked in), so 30 s costs little while filtering momentary flaps
 *     during identity propagation.
 *   - 60 s → 120 → 240 → 480 → 900 (capped) backoff — spaces attempts so the
 *     system has time to recover between recreates and can't storm.
 *   - 5 attempts — after ~15 min of failed self-heal a systemic problem is
 *     assumed and the supervisor stops, emitting a cap-reached alarm.
 */
export const DEFAULT_SELF_HEAL_CONFIG: SelfHealConfig = {
  tickIntervalMs: 15_000,
  dwellMs: 30_000,
  baseBackoffMs: 60_000,
  maxBackoffMs: 900_000,
  maxAttempts: 5,
};

/** Identifying context for an audit event (shared by recreate + cap-reached). */
export interface SelfHealTargetBase {
  stackId: string;
  stackName: string;
  kind: EgressStackKind;
  environmentId: string | null;
  maxAttempts: number;
  connState: EgressAgentConnState | null;
}

/** A single recreate action; `attempt` is 1-based. */
export interface RecreateTarget extends SelfHealTargetBase {
  attempt: number;
}

/** Injectable I/O boundary — real impls below, fakes in the unit tests. */
export interface SelfHealDeps {
  /** Enumerate the egress NATS-client stacks and probe each one's health. */
  probe: () => Promise<EgressStackHealthProbe[]>;
  /** Whether auto-remediation is enabled (the feature flag). */
  isEnabled: () => Promise<boolean>;
  /** Force-recreate a stack (audits + `reconciler.update({ forceRecreate: true })`). */
  recreate: (target: RecreateTarget) => Promise<void>;
  /** Audit that a stack hit the attempt cap and auto-remediation stopped. */
  onCapReached: (target: SelfHealTargetBase) => Promise<void>;
  /** Whether a long-running operation is already in flight for the stack. */
  isLocked: (stackId: string) => boolean;
  /** Clock — injected so tests are deterministic. */
  now: () => number;
  /** Tunable overrides (merged over the defaults). */
  config?: Partial<SelfHealConfig>;
}

interface StackHealState {
  /** When `auth-failed` was first observed *continuously*; null once it lapses. */
  authFailingSinceMs: number | null;
  /** Recreate attempts made so far. */
  attempts: number;
  /** Wall-clock of the last recreate (for the backoff window). */
  lastAttemptAtMs: number | null;
  /** Whether the cap-reached alarm has already fired (emit-once). */
  capReachedEmitted: boolean;
}

export class EgressSelfHealSupervisor {
  private readonly deps: SelfHealDeps;
  private readonly config: SelfHealConfig;
  private readonly state = new Map<string, StackHealState>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(deps: SelfHealDeps) {
    this.deps = deps;
    this.config = { ...DEFAULT_SELF_HEAL_CONFIG, ...(deps.config ?? {}) };
  }

  /** Start the interval watcher. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.config.tickIntervalMs);
    // Deliberately no immediate tick: let the Phase 3 health watcher populate a
    // connection state first, and let dwell filter cold-boot noise.
    log.info(
      {
        tickIntervalMs: this.config.tickIntervalMs,
        dwellMs: this.config.dwellMs,
        maxAttempts: this.config.maxAttempts,
      },
      "egress self-heal supervisor started",
    );
  }

  /** Stop the watcher and drop all per-stack state. For shutdown + tests. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state.clear();
  }

  /** Backoff window that must elapse after `attempts` recreates. */
  private backoffMs(attempts: number): number {
    const exp = this.config.baseBackoffMs * Math.pow(2, Math.max(0, attempts - 1));
    return Math.min(exp, this.config.maxBackoffMs);
  }

  private getState(stackId: string): StackHealState {
    let s = this.state.get(stackId);
    if (!s) {
      s = { authFailingSinceMs: null, attempts: 0, lastAttemptAtMs: null, capReachedEmitted: false };
      this.state.set(stackId, s);
    }
    return s;
  }

  /**
   * One supervisor pass. Public so tests can drive it deterministically. Never
   * overlaps itself (a slow recreate can outlast a tick interval).
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let enabled: boolean;
      try {
        enabled = await this.deps.isEnabled();
      } catch (err) {
        log.warn({ err }, "self-heal feature-flag read failed — skipping tick");
        return;
      }
      // Flag OFF ⇒ take no action whatsoever (checked before any recreate).
      if (!enabled) return;

      let probes: EgressStackHealthProbe[];
      try {
        probes = await this.deps.probe();
      } catch (err) {
        log.warn({ err }, "self-heal probe failed — skipping tick");
        return;
      }

      const now = this.deps.now();
      // Forget state for stacks that no longer exist (destroyed).
      const live = new Set(probes.map((p) => p.stackId));
      for (const id of Array.from(this.state.keys())) {
        if (!live.has(id)) this.state.delete(id);
      }

      for (const p of probes) {
        try {
          await this.evaluate(p, now);
        } catch (err) {
          log.error({ err, stackId: p.stackId }, "self-heal evaluation failed for stack");
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(p: EgressStackHealthProbe, now: number): Promise<void> {
    const s = this.getState(p.stackId);

    // Recovery — a clean `connected` resets everything for the stack.
    if (p.connState === "connected") {
      if (s.attempts > 0 || s.authFailingSinceMs !== null) {
        log.info(
          { stackId: p.stackId, kind: p.kind },
          "egress stack recovered to connected — resetting self-heal state",
        );
      }
      this.state.delete(p.stackId);
      return;
    }

    // Only a running container reporting `auth-failed` is a candidate. Anything
    // else (reconnecting / disconnected / unreachable / not-running) clears the
    // dwell marker but preserves attempts+backoff — those only reset on a clean
    // `connected` recovery above.
    const authFailing = p.containerRunning && p.connState === "auth-failed";
    if (!authFailing) {
      s.authFailingSinceMs = null;
      return;
    }

    if (s.authFailingSinceMs === null) s.authFailingSinceMs = now;

    // Dwell gate — require the failure to persist before acting.
    if (now - s.authFailingSinceMs < this.config.dwellMs) return;

    // Cap gate — stop (and alarm once) after the hard attempt cap.
    if (s.attempts >= this.config.maxAttempts) {
      if (!s.capReachedEmitted) {
        s.capReachedEmitted = true;
        log.error(
          { stackId: p.stackId, kind: p.kind, attempts: s.attempts, maxAttempts: this.config.maxAttempts },
          "egress self-heal cap reached — stopping auto-recreate; manual intervention required",
        );
        try {
          await this.deps.onCapReached({
            stackId: p.stackId,
            stackName: p.stackName,
            kind: p.kind,
            environmentId: p.environmentId,
            maxAttempts: this.config.maxAttempts,
            connState: p.connState,
          });
        } catch (err) {
          log.warn({ err, stackId: p.stackId }, "cap-reached audit emit failed (non-fatal)");
        }
      }
      return;
    }

    // Backoff gate — one recreate per backoff window.
    if (s.lastAttemptAtMs !== null && now - s.lastAttemptAtMs < this.backoffMs(s.attempts)) {
      return;
    }

    // Operation-lock gate — never recreate a stack that's mid-operation.
    if (this.deps.isLocked(p.stackId)) {
      log.debug(
        { stackId: p.stackId },
        "egress stack has an operation in progress — deferring self-heal recreate",
      );
      return;
    }

    // Act. Record the attempt *before* awaiting so a slow/failed recreate still
    // advances backoff and the cap (a failing recreate must not loop tightly).
    s.attempts += 1;
    s.lastAttemptAtMs = now;
    const attempt = s.attempts;
    log.warn(
      { stackId: p.stackId, kind: p.kind, attempt, maxAttempts: this.config.maxAttempts },
      "auto-recreating auth-failing egress stack to re-mint NATS credentials",
    );
    try {
      await this.deps.recreate({
        stackId: p.stackId,
        stackName: p.stackName,
        kind: p.kind,
        environmentId: p.environmentId,
        attempt,
        maxAttempts: this.config.maxAttempts,
        connState: p.connState,
      });
    } catch (err) {
      log.error({ err, stackId: p.stackId }, "auto-recreate of egress stack failed");
    }
  }

  /** Test-only: inspect a stack's internal state. */
  _getStateForTest(stackId: string): Readonly<StackHealState> | undefined {
    return this.state.get(stackId);
  }
}

// ===========================================================================
// Production wiring — builds the real deps for the singleton supervisor.
// ===========================================================================

const FW_AGENT_TEMPLATE = "egress-fw-agent";
const GATEWAY_TEMPLATE = "egress-gateway";
const GATEWAY_SERVICE_LABEL = "mini-infra.service";
const GATEWAY_SERVICE_VALUE = "egress-gateway";

/**
 * Enumerate the egress NATS-client stacks (host fw-agent + per-environment
 * gateways) and probe each one's out-of-band connection state.
 *
 *   - fw-agent: container from `findFwAgent()`, connState from the Phase 3
 *     watcher's cached `getFwAgentConnState()`.
 *   - gateway: container state by label, connState from `scrapeGatewayConnState`.
 */
async function probeEgressStacks(prisma: PrismaClient): Promise<EgressStackHealthProbe[]> {
  const probes: EgressStackHealthProbe[] = [];

  const templates = await prisma.stackTemplate.findMany({
    where: { source: "system", name: { in: [FW_AGENT_TEMPLATE, GATEWAY_TEMPLATE] } },
    select: { id: true, name: true, scope: true },
  });
  const fwTemplate = templates.find((t) => t.name === FW_AGENT_TEMPLATE && t.scope === "host");
  const gwTemplate = templates.find((t) => t.name === GATEWAY_TEMPLATE && t.scope === "environment");

  // Host fw-agent stack (singleton).
  if (fwTemplate) {
    const fwStack = await prisma.stack.findFirst({
      where: { templateId: fwTemplate.id, environmentId: null, status: { not: "removed" } },
      select: { id: true, name: true },
    });
    if (fwStack) {
      const found = await findFwAgent();
      probes.push({
        stackId: fwStack.id,
        stackName: fwStack.name,
        kind: "fw-agent",
        environmentId: null,
        containerRunning: found?.state === "running",
        connState: getFwAgentConnState(),
      });
    }
  }

  // Per-environment gateway stacks.
  if (gwTemplate) {
    const gwStacks = await prisma.stack.findMany({
      where: {
        templateId: gwTemplate.id,
        status: { not: "removed" },
        environmentId: { not: null },
      },
      select: { id: true, name: true, environmentId: true },
    });
    for (const gw of gwStacks) {
      if (!gw.environmentId) continue;
      const containerRunning = await isGatewayContainerRunning(gw.environmentId);
      const connState = await scrapeGatewayConnState(gw.environmentId);
      probes.push({
        stackId: gw.id,
        stackName: gw.name,
        kind: "gateway",
        environmentId: gw.environmentId,
        containerRunning,
        connState,
      });
    }
  }

  return probes;
}

/** Whether a running gateway container exists for the environment. Never throws. */
async function isGatewayContainerRunning(environmentId: string): Promise<boolean> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const list = await docker.listContainers({
      all: true,
      filters: {
        label: [`${GATEWAY_SERVICE_LABEL}=${GATEWAY_SERVICE_VALUE}`, `mini-infra.environment=${environmentId}`],
      },
    });
    return list.some((c) => c.State === "running");
  } catch (err) {
    log.debug(
      { environmentId, err: err instanceof Error ? err.message : String(err) },
      "gateway container-state probe failed",
    );
    return false;
  }
}

/** Feature-flag read — default ON, disabled by `egress-fw-agent.auto_remediation=false`. */
async function isAutoRemediationEnabled(): Promise<boolean> {
  const cfg = await getFwAgentConfig();
  return cfg.autoRemediation;
}

/**
 * Force-recreate an egress stack to re-mint its NATS credentials, auditing the
 * attempt as an infrastructure `UserEvent`. Uses `reconciler.update(stackId, {
 * forceRecreate: true })` — the SAME primitive the manual
 * `POST /api/stacks/:id/update` route uses — NOT a container restart (a restart
 * would reuse the stale baked-in creds; see the file header).
 */
export async function recreateEgressStackForSelfHeal(
  prisma: PrismaClient,
  target: RecreateTarget,
): Promise<void> {
  const userEvents = new UserEventService(prisma);

  // Hold the operation lock for the whole recreate. The supervisor already
  // checked `isLocked()`, but acquiring here closes the race with a concurrent
  // manual apply/update/destroy.
  if (!stackOperationLock.tryAcquire(target.stackId)) {
    log.warn(
      { stackId: target.stackId },
      "self-heal recreate skipped — stack operation lock already held",
    );
    return;
  }

  let eventId: string | null = null;
  try {
    try {
      const event = await userEvents.createEvent({
        eventType: "stack_update",
        eventCategory: "infrastructure",
        eventName: `Auto-heal: recreate ${target.stackName}`,
        triggeredBy: "system",
        status: "running",
        progress: 0,
        resourceId: target.stackId,
        resourceType: "stack",
        resourceName: target.stackName,
        description:
          `Egress ${target.kind} stack "${target.stackName}" is auth-failing against NATS ` +
          `(state: ${target.connState ?? "unknown"}); force-recreating to re-mint credentials ` +
          `(attempt ${target.attempt}/${target.maxAttempts}).`,
        metadata: {
          autoRemediation: true,
          kind: target.kind,
          environmentId: target.environmentId,
          attempt: target.attempt,
          maxAttempts: target.maxAttempts,
          connState: target.connState,
        },
      });
      eventId = event.id;
    } catch (err) {
      log.warn(
        { err, stackId: target.stackId },
        "failed to create self-heal recreate UserEvent (non-fatal)",
      );
    }

    const { reconciler } = await buildStackOperationServices();
    const result = await reconciler.update(target.stackId, {
      triggeredBy: "system",
      forceRecreate: true,
      onProgress: (serviceResult, completedCount, totalActions) => {
        emitStackApplyServiceResult(target.stackId, serviceResult, completedCount, totalActions);
      },
    });

    const failed = result.serviceResults.filter((r) => !r.success);
    if (eventId) {
      await userEvents.updateEvent(eventId, {
        status: failed.length > 0 ? "failed" : "completed",
        progress: 100,
        resultSummary:
          failed.length > 0
            ? `${failed.length} service(s) failed to recreate`
            : `Recreated ${result.serviceResults.length} service(s) to re-mint NATS credentials`,
        ...(failed.length > 0
          ? { errorMessage: `Failed services: ${failed.map((r) => r.serviceName).join(", ")}` }
          : {}),
      });
    }
    emitStackApplyCompleted({ ...result });
  } catch (err) {
    log.error(
      { err, stackId: target.stackId },
      "self-heal reconciler.update (forceRecreate) failed",
    );
    if (eventId) {
      try {
        await userEvents.updateEvent(eventId, {
          status: "failed",
          progress: 100,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* never break the recreate path on an audit failure */
      }
    }
    emitStackApplyFailed(target.stackId, err);
  } finally {
    stackOperationLock.release(target.stackId);
  }
}

/** Audit a cap-reached stop as a failed infrastructure `UserEvent`. */
async function emitCapReachedEvent(prisma: PrismaClient, target: SelfHealTargetBase): Promise<void> {
  const userEvents = new UserEventService(prisma);
  await userEvents.createEvent({
    eventType: "system_maintenance",
    eventCategory: "infrastructure",
    eventName: `Auto-heal cap reached: ${target.stackName}`,
    triggeredBy: "system",
    status: "failed",
    progress: 0,
    resourceId: target.stackId,
    resourceType: "stack",
    resourceName: target.stackName,
    description:
      `Egress ${target.kind} stack "${target.stackName}" is still auth-failing after ` +
      `${target.maxAttempts} auto-recreate attempts. Auto-remediation has stopped for this stack — ` +
      `manual intervention required (check NATS identity/credentials in Vault).`,
    metadata: {
      autoRemediation: true,
      capReached: true,
      kind: target.kind,
      environmentId: target.environmentId,
      maxAttempts: target.maxAttempts,
      connState: target.connState,
    },
  });
}

// ---------------------------------------------------------------------------
// Singleton lifecycle — modelled on `startFwAgentHealthWatcher()`.
// ---------------------------------------------------------------------------

let supervisor: EgressSelfHealSupervisor | null = null;

/**
 * Start the egress self-heal supervisor. Idempotent. Call at server boot AFTER
 * `startFwAgentHealthWatcher()` (the supervisor consumes its cached signal).
 */
export function startEgressSelfHealSupervisor(prisma: PrismaClient): void {
  if (supervisor) return;
  supervisor = new EgressSelfHealSupervisor({
    probe: () => probeEgressStacks(prisma),
    isEnabled: () => isAutoRemediationEnabled(),
    recreate: (target) => recreateEgressStackForSelfHeal(prisma, target),
    onCapReached: (target) => emitCapReachedEvent(prisma, target),
    isLocked: (stackId) => stackOperationLock.has(stackId),
    now: () => Date.now(),
  });
  supervisor.start();
}

/** Stop the supervisor. For graceful shutdown + tests. */
export function stopEgressSelfHealSupervisor(): void {
  if (supervisor) {
    supervisor.stop();
    supervisor = null;
  }
}
