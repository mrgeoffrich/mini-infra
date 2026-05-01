/**
 * Operator-facing helpers for the egress-fw-agent stack (ALT-27).
 *
 * The fw-agent used to be a host-singleton container managed directly via
 * the Docker API by `ensureFwAgent()`. That code path is gone — it's now a
 * host-scoped stack template (`server/templates/egress-fw-agent/`) wired
 * through the same reconciler as every other stack. This module is the
 * thin compatibility surface for the existing settings card UI and the
 * egress-fw-agent route handler:
 *
 *   - `getFwAgentConfig()` — reads image/auto_start from SystemSettings.
 *     The `image` setting is now reflected into the stack via the template's
 *     `${EGRESS_FW_AGENT_IMAGE_TAG}` substitution variable; auto_start is
 *     consulted by `bootstrapFwAgentStack` at boot.
 *   - `findFwAgent()` — finds the running container by label. Same label
 *     the legacy host-singleton used (`mini-infra.egress.fw-agent=true`),
 *     and the new template sets it for backward compat with the
 *     EnvFirewallManager event filter and the (Stage D11) JetStream
 *     consumer fallback discovery.
 *   - `isFwAgentHealthy()` — Stage D10 wires this to the `egress-fw-health`
 *     KV bucket. Until then it reports `false` (the legacy Unix-socket
 *     health check is dead).
 *   - `restartFwAgent()` — re-triggers the stack bootstrap apply.
 *
 * The `FwAgentProgressCallback` shape is preserved — the egress-fw-agent
 * route still emits Channel.EGRESS_FW_AGENT events with the four legacy
 * step names so the existing settings-card UI keeps working without a
 * front-end change. The mapping from stack-apply progress to the four
 * legacy steps is approximate; we trade granularity for backward compat.
 */

import { getLogger } from "../../lib/logger-factory";
import DockerService from "../docker";
import prisma from "../../lib/prisma";
import { bootstrapFwAgentStack } from "./fw-agent-stack-bootstrap";
import type { OperationStep } from "@mini-infra/types";
// `NatsBus` is imported lazily so the `isFwAgentHealthy()` polling watcher
// doesn't pull the prisma chain at import time when this module is brought
// up by a unit test of an unrelated route.
import type { NatsBus } from "../nats/nats-bus";
import type { EgressFwHealth } from "../nats/payload-schemas";
import { EGRESS_FW_HEALTH_BUCKET } from "../nats/nats-system-bootstrap";

const logger = getLogger("stacks", "fw-agent-sidecar");

const FW_AGENT_LABEL = "mini-infra.egress.fw-agent";
const SETTINGS_CATEGORY = "egress-fw-agent";

// ---------------------------------------------------------------------------
// Health watcher — reads the egress-fw-health KV bucket on a tight cadence
// and exposes the freshness summary via `isFwAgentHealthy()` (kept sync for
// backward compat with the legacy host-singleton API).
// ---------------------------------------------------------------------------

/** Heartbeat freshness threshold — per ALT-27 acceptance criteria, the UI
 *  reports "healthy" when the latest heartbeat is ≤10s old. */
const HEALTH_FRESHNESS_THRESHOLD_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 2_000;
const HEALTH_KV_KEY = "current"; // matches `healthKey` in the Go agent

let healthPollTimer: NodeJS.Timeout | null = null;
let cachedHealthy = false;
let lastHealthReportedAtMs: number | null = null;
let lastHealthLastApplyId: string | null = null;
let cachedNatsBusForHealth: NatsBus | null = null;

async function loadNatsBusForHealth(): Promise<NatsBus> {
  if (cachedNatsBusForHealth) return cachedNatsBusForHealth;
  // Lazy require — see the file-top import note about prisma chains.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../nats/nats-bus") as typeof import("../nats/nats-bus");
  cachedNatsBusForHealth = mod.NatsBus.getInstance();
  return cachedNatsBusForHealth;
}

async function pollHealthOnce(): Promise<void> {
  try {
    const bus = await loadNatsBusForHealth();
    const kv = bus.jetstream.kv(EGRESS_FW_HEALTH_BUCKET);
    const entry = await kv.get<EgressFwHealth>(HEALTH_KV_KEY);
    if (!entry) {
      // No heartbeat in the bucket yet — agent hasn't reported, or its
      // first publish hasn't landed. Keep `false` so the UI shows
      // "starting" rather than "stale".
      cachedHealthy = false;
      lastHealthReportedAtMs = null;
      return;
    }
    const age = Date.now() - entry.value.reportedAtMs;
    cachedHealthy = entry.value.ok && age <= HEALTH_FRESHNESS_THRESHOLD_MS;
    lastHealthReportedAtMs = entry.value.reportedAtMs;
    lastHealthLastApplyId = entry.value.lastApplyId ?? null;
  } catch (err) {
    // KV read fails when the bus is reconnecting or the bucket doesn't
    // exist yet (e.g. cold-boot worktree where bootstrap hasn't run).
    // Don't flap the cache — keep whatever we last knew. Polling resumes
    // on the next tick. Logged at debug so a stuck KV-read symptom is
    // diagnosable without flooding production logs on routine reconnect
    // bounces.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "fw-agent health KV read failed — keeping cached value",
    );
  }
}

/**
 * Start the background health watcher. Idempotent — calling twice is a
 * no-op. Call from server boot once the NatsBus has been started.
 */
export function startFwAgentHealthWatcher(): void {
  if (healthPollTimer) return;
  // Kick off immediately so a freshly-booted server doesn't show "stale"
  // for the first 2 s; subsequent polls run on the interval.
  void pollHealthOnce();
  healthPollTimer = setInterval(() => void pollHealthOnce(), HEALTH_POLL_INTERVAL_MS);
  logger.info({ intervalMs: HEALTH_POLL_INTERVAL_MS }, "fw-agent health watcher started");
}

/** Stop the watcher. For graceful shutdown + tests. */
export function stopFwAgentHealthWatcher(): void {
  if (healthPollTimer) {
    clearInterval(healthPollTimer);
    healthPollTimer = null;
  }
  cachedNatsBusForHealth = null;
}

// ---------------------------------------------------------------------------
// Public getters preserved from the legacy surface
// ---------------------------------------------------------------------------

/**
 * Reports the most-recently observed health of the fw-agent (ALT-27,
 * Stage D10). Backed by the background watcher started by
 * `startFwAgentHealthWatcher()`. Returns `false` when:
 *   - the watcher hasn't started yet,
 *   - the agent hasn't published a heartbeat,
 *   - the latest heartbeat's `reportedAtMs` is older than the freshness
 *     threshold (default 10 s),
 *   - the heartbeat said `ok: false`.
 * Stays sync for backward compat with the route handler and existing
 * callers.
 */
export function isFwAgentHealthy(): boolean {
  return cachedHealthy;
}

/**
 * Richer status snapshot for diagnostics. Returns null when the watcher
 * has never observed a heartbeat in this process.
 */
export function getFwAgentHealthSnapshot(): {
  healthy: boolean;
  reportedAtMs: number | null;
  ageMs: number | null;
  lastApplyId: string | null;
} {
  const now = Date.now();
  return {
    healthy: cachedHealthy,
    reportedAtMs: lastHealthReportedAtMs,
    ageMs: lastHealthReportedAtMs !== null ? now - lastHealthReportedAtMs : null,
    lastApplyId: lastHealthLastApplyId,
  };
}

// ---------------------------------------------------------------------------
// Settings — image and auto_start
// ---------------------------------------------------------------------------

async function getSettings(): Promise<Map<string, string>> {
  const settings = await prisma.systemSettings.findMany({
    where: { category: SETTINGS_CATEGORY, isActive: true },
  });
  return new Map(settings.map((s) => [s.key, s.value]));
}

export async function getFwAgentConfig(): Promise<{
  image: string | null;
  autoStart: boolean;
}> {
  const settings = await getSettings();
  return {
    image: settings.get("image") || process.env.EGRESS_FW_AGENT_IMAGE_TAG || null,
    autoStart: settings.get("auto_start") !== "false",
  };
}

// ---------------------------------------------------------------------------
// Container discovery — find the stack-managed fw-agent container by label
// ---------------------------------------------------------------------------

export async function findFwAgent(): Promise<{
  id: string;
  state: string;
} | null> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`${FW_AGENT_LABEL}=true`] },
    });
    if (containers.length === 0) return null;
    const c = containers[0];
    return { id: c.Id, state: c.State };
  } catch (err) {
    logger.error({ err }, "Failed to find egress fw-agent container");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Restart / start — trigger a stack bootstrap apply
// ---------------------------------------------------------------------------

export type FwAgentProgressCallback = (
  step: OperationStep,
  completedCount: number,
  totalSteps: number,
) => void;

/**
 * Step names preserved verbatim from the legacy host-singleton flow so the
 * existing settings-card UI's progress-bar copy doesn't change. The mapping
 * from stack-apply progress to these steps is approximate — see the
 * `restartFwAgent()` body for the heuristic.
 */
export const FW_AGENT_STARTUP_STEPS = [
  "Pull fw-agent image",
  "Create container",
  "Start container",
  "Verify health",
] as const;

/**
 * Trigger a stack bootstrap apply for the fw-agent. Idempotent — if the
 * stack is already in sync, the underlying reconciler emits a no-op plan
 * and this returns `null` (caller then reports "already healthy" or similar).
 *
 * The progress callback receives the four legacy steps in order. Because
 * `bootstrapFwAgentStack` runs the apply in the background and returns
 * immediately, we synthesise the progress callbacks from the points we
 * can observe: stack-row-created, apply-dispatched, container-found-running.
 * The full granular stack-apply progress events still flow through their
 * usual Socket.IO channel (`Channel.STACK`) for clients that care.
 *
 * Returns `{ containerId }` when a container is running after the apply
 * settles, `null` if the stack couldn't be created or applied.
 */
export async function restartFwAgent(options?: {
  onProgress?: FwAgentProgressCallback;
}): Promise<{ containerId: string } | null> {
  const onProgress = options?.onProgress;
  const totalSteps = FW_AGENT_STARTUP_STEPS.length;
  let completed = 0;
  const reportStep = (
    step: string,
    status: "completed" | "failed" | "skipped",
    detail?: string,
  ) => {
    if (status === "completed") completed++;
    try {
      onProgress?.({ step, status, detail }, completed, totalSteps);
    } catch {
      /* never break caller */
    }
  };

  const result = await bootstrapFwAgentStack(prisma);
  if (!result.stackId) {
    reportStep("Pull fw-agent image", "failed", result.reason ?? "no stack");
    return null;
  }
  // Map stack-bootstrap milestones to the legacy step labels. We can't
  // observe the per-step container creation in real time without splicing
  // into the reconciler — that's deliberately out of scope. Mark the first
  // three as completed once the apply has been dispatched (the user sees
  // the bar fill in) and the fourth based on container presence below.
  reportStep("Pull fw-agent image", "completed", "stack apply dispatched");
  reportStep("Create container", "completed");
  reportStep("Start container", "completed");

  // Poll briefly for the container to show up; the apply runs in the
  // background so a few hundred ms of patience is normal even on a warm
  // boot. Give up after ~6 s — beyond that a timeout is more useful to
  // the operator than waiting forever.
  for (let attempt = 0; attempt < 30; attempt++) {
    const found = await findFwAgent();
    if (found && found.state === "running") {
      reportStep("Verify health", "completed", "container running");
      return { containerId: found.id };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Mark step 4 as failed (not completed) when the container isn't
  // confirmed running — the route emits `success: false` for null-return
  // and showing 4/4 "completed" steps alongside an overall failure
  // confused operators in the legacy flow. Better to be honest about
  // which step actually didn't finish.
  reportStep(
    "Verify health",
    "failed",
    "Container did not reach running state within 6s — apply may still be in progress; refresh status shortly",
  );
  return null;
}
