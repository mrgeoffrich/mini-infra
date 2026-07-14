/**
 * Live egress-agent NATS credential refresh (egress NATS cred-resilience plan,
 * Phase 6 — the graceful fast-path).
 *
 * When a NATS identity rotation would otherwise orphan a running egress
 * agent's baked-in credential, this module re-mints the agent's cred and
 * **rewrites its per-stack `<stackId>.creds` file in place** in the agent's
 * `nats_creds` docker volume (via Phase 5's `writeNatsCredsFiles`). The agent's
 * nats.go re-reads that file on **every reconnect** (Phase 5 behaviour), so the
 * very next reconnect — the old cred is already auth-failing, so nats.go is
 * retrying every ~2 s — reads the fresh cred and recovers within seconds. No
 * container recreate, no Go change; Phase 4's 30 s self-heal dwell never fires.
 *
 * ── Composition with Phase 4 (the backstop) ────────────────────────────────
 * Live-refresh is the graceful path; Phase 4's self-heal supervisor is the
 * recreate-based backstop. This module never hand-rolls a recreate. When the
 * feature flag is off, or a re-mint / volume write fails, it simply logs +
 * audits and does nothing else — the agent stays auth-failing and Phase 4
 * recreates it on its next dwell. So a live-push failure still recovers.
 *
 * ── Trigger ────────────────────────────────────────────────────────────────
 * Driven by the control plane's post-`applyConfig` hook
 * (`setNatsPostApplyHook`), fired only when an apply actually *rotated* the
 * NATS identity (`NatsIdentityRotationInfo.rotated`). Routine applies that
 * leave identity untouched never re-mint, so steady-state churn is zero.
 *
 * The state-less core (`refreshEgressAgentCreds`) is decoupled from all I/O via
 * injected deps so it is unit-testable without Docker / NATS / Prisma; the
 * production wiring below builds the real deps (enumerate → mint → write →
 * audit) and registers the hook.
 */

import type { PrismaClient } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import DockerService from "../docker";
import { DockerExecutorService } from "../docker-executor";
import {
  getNatsControlPlaneService,
  setNatsPostApplyHook,
  type NatsIdentityRotationInfo,
} from "../nats/nats-control-plane-service";
import {
  writeNatsCredsFiles,
  natsCredsFileName,
  type NatsCredsFileSpec,
} from "../nats/nats-creds-volume";
import { getStackProjectName } from "../stacks/template-engine";
import { UserEventService } from "../user-events/user-event-service";
import { getFwAgentConfig } from "./fw-agent-sidecar";
import type { EgressStackKind } from "./egress-self-heal-supervisor";

const log = getLogger("stacks", "egress-cred-refresh");

const FW_AGENT_TEMPLATE = "egress-fw-agent";
const GATEWAY_TEMPLATE = "egress-gateway";

/** A single running egress NATS-client agent whose creds file can be rewritten. */
export interface RunningEgressAgent {
  stackId: string;
  stackName: string;
  kind: EgressStackKind;
  /** Environment id for gateways; null for the host fw-agent stack. */
  environmentId: string | null;
  /** Compose project name — `<projectName>_nats_creds` is the volume to write. */
  projectName: string;
  /** The `NatsCredentialProfile` id bound to the agent's service (to re-mint). */
  credentialProfileId: string;
}

/** Injectable I/O boundary — real impls in the wiring below, fakes in tests. */
export interface EgressCredRefreshDeps {
  /** Whether live cred refresh is enabled (the Phase 6 feature flag). */
  isEnabled: () => Promise<boolean>;
  /** Enumerate the running egress agents whose creds file can be rewritten. */
  listRunningAgents: () => Promise<RunningEgressAgent[]>;
  /** Re-mint a fresh `.creds` blob for a bound credential profile. */
  mint: (credentialProfileId: string) => Promise<string>;
  /** Rewrite the given `.creds` file(s) into a stack's `nats_creds` volume. */
  writeCreds: (projectName: string, files: NatsCredsFileSpec[]) => Promise<void>;
  /** Audit a successful live-refresh push for an agent. */
  auditPush: (agent: RunningEgressAgent, reason: string) => Promise<void>;
  /** Audit a failed push (recovery then defers to Phase 4's self-heal). */
  auditFailure: (agent: RunningEgressAgent, reason: string, err: unknown) => Promise<void>;
}

export interface EgressCredRefreshResult {
  /** Whether the feature flag allowed any push at all. */
  enabled: boolean;
  /** Running agents considered this run. */
  attempted: number;
  /** Agents whose creds file was successfully rewritten. */
  pushed: number;
  /** Agents whose re-mint / write failed (left to Phase 4's recreate). */
  failed: number;
}

/**
 * Re-mint and rewrite the creds file for every running egress agent so each
 * recovers on its next reconnect with no container recreate. Never throws — a
 * per-agent failure is audited and left to Phase 4's recreate-based self-heal;
 * a disabled flag is a clean no-op that also defers to Phase 4.
 */
export async function refreshEgressAgentCreds(
  deps: EgressCredRefreshDeps,
  opts: { reason: string },
): Promise<EgressCredRefreshResult> {
  let enabled: boolean;
  try {
    enabled = await deps.isEnabled();
  } catch (err) {
    // Flag read failed — treat as "don't push" and let Phase 4 handle recovery
    // rather than risk a churn on an unreadable setting.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "live cred refresh flag read failed — skipping (deferring to self-heal)",
    );
    return { enabled: false, attempted: 0, pushed: 0, failed: 0 };
  }
  if (!enabled) {
    log.info(
      { reason: opts.reason },
      "NATS identity rotated but live cred refresh is disabled — deferring to Phase 4 self-heal recreate",
    );
    return { enabled: false, attempted: 0, pushed: 0, failed: 0 };
  }

  let agents: RunningEgressAgent[];
  try {
    agents = await deps.listRunningAgents();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to enumerate running egress agents for live cred refresh — deferring to self-heal",
    );
    return { enabled: true, attempted: 0, pushed: 0, failed: 0 };
  }

  if (agents.length === 0) {
    log.info({ reason: opts.reason }, "NATS identity rotated but no running egress agents to refresh");
    return { enabled: true, attempted: 0, pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;
  for (const agent of agents) {
    try {
      const creds = await deps.mint(agent.credentialProfileId);
      await deps.writeCreds(agent.projectName, [
        { fileName: natsCredsFileName(agent.stackId), contents: creds },
      ]);
      pushed++;
      log.info(
        { stackId: agent.stackId, kind: agent.kind, projectName: agent.projectName, reason: opts.reason },
        "live-refreshed egress agent NATS creds in place (no container recreate)",
      );
      try {
        await deps.auditPush(agent, opts.reason);
      } catch (auditErr) {
        log.warn(
          { err: auditErr instanceof Error ? auditErr.message : String(auditErr), stackId: agent.stackId },
          "live cred refresh push audit failed (non-fatal)",
        );
      }
    } catch (err) {
      failed++;
      log.error(
        { err: err instanceof Error ? err.message : String(err), stackId: agent.stackId, kind: agent.kind },
        "live cred refresh failed for egress agent — deferring to Phase 4 self-heal recreate",
      );
      try {
        await deps.auditFailure(agent, opts.reason, err);
      } catch (auditErr) {
        log.warn(
          { err: auditErr instanceof Error ? auditErr.message : String(auditErr), stackId: agent.stackId },
          "live cred refresh failure audit failed (non-fatal)",
        );
      }
    }
  }

  return { enabled: true, attempted: agents.length, pushed, failed };
}

/**
 * Build the post-apply handler from a set of deps. Only a *real* rotation
 * (`info.rotated`) triggers a re-mint; a routine reconcile is a clean no-op so
 * steady-state applies never churn agent creds. Exposed (with injectable deps)
 * so the "no-op apply does not re-mint" path is unit-testable.
 */
export function makeNatsPostApplyHandler(
  deps: EgressCredRefreshDeps,
): (info: NatsIdentityRotationInfo) => Promise<void> {
  return async (info: NatsIdentityRotationInfo): Promise<void> => {
    if (!info.rotated) {
      log.debug(
        { operatorPublic: info.operatorPublic, generatedSeeds: info.generatedSeeds },
        "applyConfig did not rotate NATS identity — no live cred refresh needed",
      );
      return;
    }
    const reason = `NATS identity rotation (operator ${info.operatorPublic.slice(0, 12)}…)`;
    log.warn({ operatorPublic: info.operatorPublic }, "NATS identity rotated — live-refreshing running egress agent creds");
    await refreshEgressAgentCreds(deps, { reason });
  };
}

// ===========================================================================
// Production wiring — builds the real deps and registers the hook.
// ===========================================================================

// Lazily-built, cached Docker executor. `DockerExecutorService` has no
// singleton accessor and `initialize()` connects to the daemon, so build it
// once on first rotation rather than per push (rotations are rare, but the
// executor is reused across the agents in one rotation and across rotations).
let cachedExecutor: DockerExecutorService | null = null;
async function getExecutor(): Promise<DockerExecutorService> {
  if (cachedExecutor) return cachedExecutor;
  const exec = new DockerExecutorService();
  await exec.initialize();
  cachedExecutor = exec;
  return exec;
}

/** Whether any container for the stack is currently running (via stack-id label). */
async function isStackContainerRunning(stackId: string): Promise<boolean> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    // `all: false` ⇒ only running containers; a non-empty list means running.
    const list = await docker.listContainers({
      all: false,
      filters: { label: [`mini-infra.stack-id=${stackId}`] },
    });
    return list.length > 0;
  } catch (err) {
    log.debug(
      { stackId, err: err instanceof Error ? err.message : String(err) },
      "stack container-running probe failed (treating as not running)",
    );
    return false;
  }
}

/**
 * Enumerate the running egress NATS-client agents (host `egress-fw-agent` +
 * per-environment `egress-gateway` stacks) whose creds file can be rewritten.
 *
 * A stack is included only when (a) a container is currently running for it and
 * (b) its NATS-bound service has a resolved `natsCredentialId` (the apply phase
 * has materialised + bound the role profile). A stopped/undeployed or unbound
 * stack is skipped — it gets fresh creds at its next create anyway.
 */
export async function listRunningEgressAgents(prisma: PrismaClient): Promise<RunningEgressAgent[]> {
  const templates = await prisma.stackTemplate.findMany({
    where: { source: "system", name: { in: [FW_AGENT_TEMPLATE, GATEWAY_TEMPLATE] } },
    select: { id: true, name: true, scope: true },
  });
  const fwTemplate = templates.find((t) => t.name === FW_AGENT_TEMPLATE && t.scope === "host");
  const gwTemplate = templates.find((t) => t.name === GATEWAY_TEMPLATE && t.scope === "environment");

  const candidates: Array<{
    stackId: string;
    stackName: string;
    kind: EgressStackKind;
    environmentId: string | null;
    environmentName: string | null;
    services: Array<{ natsCredentialId: string | null }>;
  }> = [];

  if (fwTemplate) {
    const fwStacks = await prisma.stack.findMany({
      where: { templateId: fwTemplate.id, environmentId: null },
      select: {
        id: true,
        name: true,
        services: { select: { natsCredentialId: true } },
      },
    });
    for (const s of fwStacks) {
      candidates.push({
        stackId: s.id,
        stackName: s.name,
        kind: "fw-agent",
        environmentId: null,
        environmentName: null,
        services: s.services,
      });
    }
  }

  if (gwTemplate) {
    const gwStacks = await prisma.stack.findMany({
      where: { templateId: gwTemplate.id, environmentId: { not: null } },
      select: {
        id: true,
        name: true,
        environmentId: true,
        environment: { select: { name: true } },
        services: { select: { natsCredentialId: true } },
      },
    });
    for (const s of gwStacks) {
      candidates.push({
        stackId: s.id,
        stackName: s.name,
        kind: "gateway",
        environmentId: s.environmentId,
        environmentName: s.environment?.name ?? null,
        services: s.services,
      });
    }
  }

  const agents: RunningEgressAgent[] = [];
  for (const c of candidates) {
    const credentialProfileId = c.services.find((svc) => svc.natsCredentialId)?.natsCredentialId ?? null;
    if (!credentialProfileId) {
      log.debug(
        { stackId: c.stackId, kind: c.kind },
        "egress stack has no bound NATS credential profile yet — skipping live refresh",
      );
      continue;
    }
    if (!(await isStackContainerRunning(c.stackId))) continue;
    // Same derivation the reconciler + Phase-5 writer used to CREATE the volume
    // (`<projectName>_nats_creds`), so we target the exact same volume.
    const projectName = getStackProjectName({
      name: c.stackName,
      environment: c.environmentName ? { name: c.environmentName } : null,
    });
    agents.push({
      stackId: c.stackId,
      stackName: c.stackName,
      kind: c.kind,
      environmentId: c.environmentId,
      projectName,
      credentialProfileId,
    });
  }
  return agents;
}

/** Audit a live-refresh push (success or failure) as an infrastructure UserEvent. */
async function auditLiveRefresh(
  userEvents: UserEventService,
  agent: RunningEgressAgent,
  reason: string,
  err: unknown,
): Promise<void> {
  const failed = err !== null;
  await userEvents.createEvent({
    eventType: "system_maintenance",
    eventCategory: "infrastructure",
    eventName: `${failed ? "Live cred refresh failed" : "Live cred refresh"}: ${agent.stackName}`,
    triggeredBy: "system",
    status: failed ? "failed" : "completed",
    progress: 100,
    resourceId: agent.stackId,
    resourceType: "stack",
    resourceName: agent.stackName,
    description: failed
      ? `Egress ${agent.kind} stack "${agent.stackName}" NATS creds could not be refreshed in place after an ` +
        `identity rotation (${reason}); deferring to Phase 4 self-heal recreate.`
      : `Egress ${agent.kind} stack "${agent.stackName}" NATS creds were re-minted and rewritten in place after an ` +
        `identity rotation (${reason}); the agent recovers on its next reconnect with no container recreate.`,
    metadata: {
      liveCredRefresh: true,
      kind: agent.kind,
      environmentId: agent.environmentId,
      projectName: agent.projectName,
      reason,
      ...(failed ? { error: err instanceof Error ? err.message : String(err) } : {}),
    },
  });
}

/** Build the production deps for the post-apply hook. */
function buildEgressCredRefreshDeps(prisma: PrismaClient): EgressCredRefreshDeps {
  const userEvents = new UserEventService(prisma);
  return {
    isEnabled: async () => (await getFwAgentConfig()).liveCredRefresh,
    listRunningAgents: () => listRunningEgressAgents(prisma),
    mint: async (credentialProfileId) => {
      const res = await getNatsControlPlaneService(prisma).mintCredentialsForProfile(credentialProfileId);
      return res.creds;
    },
    writeCreds: async (projectName, files) =>
      writeNatsCredsFiles(await getExecutor(), { projectName, files }),
    auditPush: (agent, reason) => auditLiveRefresh(userEvents, agent, reason, null),
    auditFailure: (agent, reason, err) => auditLiveRefresh(userEvents, agent, reason, err),
  };
}

/**
 * Register the Phase 6 live-cred-refresh hook on the NATS control plane.
 * Idempotent — a second call replaces the handler. Call at server boot after
 * the fw-agent health watcher / self-heal supervisor are started.
 */
export function registerEgressCredRefreshHook(prisma: PrismaClient): void {
  setNatsPostApplyHook(makeNatsPostApplyHandler(buildEgressCredRefreshDeps(prisma)));
  log.info("egress live cred refresh hook registered");
}

/** Clear the hook. For graceful shutdown + tests. */
export function unregisterEgressCredRefreshHook(): void {
  setNatsPostApplyHook(null);
  cachedExecutor = null;
}
