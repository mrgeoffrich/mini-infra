/**
 * Stack-level boot bootstrap for the egress-fw-agent.
 *
 * Replaces the legacy host-singleton `ensureFwAgent()` flow (ALT-27). The
 * fw-agent is now a host-scoped stack template (`server/templates/egress-
 * fw-agent/`) that runs in `network_mode: host` with NATS_URL/NATS_CREDS
 * injected via dynamicEnv. This module preserves the boot-time UX of the
 * old sidecar — "the fw-agent just runs after a fresh install" — while
 * routing through the same code path as every other stack.
 *
 * Two phases. They run in order at boot but operate independently so a
 * partial failure in one doesn't tank the other:
 *
 *   1. **Ensure the stack DB row exists.** Idempotent: looks up the
 *      stack by templateId; if missing and the system template is
 *      already on disk, calls `StackTemplateService.createStackFromTemplate`
 *      to materialize it. No apply, no Docker side effects.
 *
 *   2. **Apply in the background.** Fire-and-forget. Waits up to 30s for
 *      the NatsBus to reach `connected` (fw-agent's NATS_CREDS minting
 *      requires a live NATS), then runs the same vault → nats → apply
 *      pipeline the HTTP route uses. Any failure is logged at warn —
 *      operator can retry via the egress-fw-agent settings card.
 *
 * Auto-start opt-out: setting `egress-fw-agent.auto_start=false` in
 * SystemSettings preserves the legacy "user manages it" mode. The stack
 * row is still created so the UI has something to show; only the apply
 * is skipped.
 */

import type { PrismaClient } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import { NatsBus } from "../nats/nats-bus";
import { StackTemplateService } from "../stacks/stack-template-service";
import { buildStackOperationServices } from "../stacks/stack-operation-context";
import { runStackVaultApplyPhase } from "../stacks/stack-vault-apply-orchestrator";
import { runStackNatsApplyPhase } from "../stacks/stack-nats-apply-orchestrator";

const log = getLogger("stacks", "fw-agent-stack-bootstrap");

const TEMPLATE_NAME = "egress-fw-agent";
const STACK_NAME = "egress-fw-agent";
const SETTINGS_CATEGORY = "egress-fw-agent";
const AUTO_START_KEY = "auto_start";
const SYSTEM_USER = "system";
/**
 * Window we wait for NatsBus to reach connected before kicking off apply.
 * On a fresh worktree the vault-nats stack is also coming up; 30s is the
 * empirical p95 for a cold worktree boot to reach a usable NATS. Beyond
 * that we still attempt the apply — the apply will fail with a clear
 * "NATS not ready" error and the user retries from the settings card.
 */
const NATS_READY_TIMEOUT_MS = 30_000;

export interface BootstrapFwAgentStackResult {
  /** Stack row id; null when no stack was created (auto-start off, template missing). */
  stackId: string | null;
  /** Whether the apply was fired in the background. False = stack created but not applied. */
  applyDispatched: boolean;
  /** Short human-readable reason on no-op paths. Mirrors the legacy log lines. */
  reason: string | null;
}

/**
 * Idempotent boot entry point. Safe to call from `server.ts` (see the
 * `ensureFwAgent` call site this replaces) and from the docker-reconnect
 * callback. A second call with the stack already created and applied is a
 * cheap series of DB lookups — no side effects.
 */
export async function bootstrapFwAgentStack(
  prisma: PrismaClient,
): Promise<BootstrapFwAgentStackResult> {
  // Auto-start opt-out. Same setting key the legacy host-singleton honored,
  // so an operator who turned it off keeps that intent.
  const autoStartRow = await prisma.systemSettings.findFirst({
    where: { category: SETTINGS_CATEGORY, key: AUTO_START_KEY, isActive: true },
  });
  const autoStart = !autoStartRow || autoStartRow.value !== "false";

  // The system template is upserted earlier in boot by `syncBuiltinStacks`.
  // We don't sync it here; if it's missing the boot order is broken and
  // a non-fatal warn is correct.
  const template = await prisma.stackTemplate.findFirst({
    where: { name: TEMPLATE_NAME, scope: "host", source: "system" },
    select: { id: true, currentVersionId: true },
  });
  if (!template?.currentVersionId) {
    log.warn(
      { templateName: TEMPLATE_NAME },
      "egress-fw-agent template not synced yet — skipping bootstrap (will retry on next boot)",
    );
    return { stackId: null, applyDispatched: false, reason: "template not synced" };
  }

  // Find an existing stack from this template at host scope. We deliberately
  // include `removed` rows in the negation so a destroy → re-bootstrap
  // cycle works the same way the legacy `ensureFwAgent` pattern did
  // (where `findFwAgent` only returned non-removed containers).
  const existing = await prisma.stack.findFirst({
    where: { templateId: template.id, environmentId: null, status: { not: "removed" } },
    select: { id: true },
  });

  let stackId: string;
  if (existing) {
    stackId = existing.id;
  } else {
    try {
      const tplService = new StackTemplateService(prisma);
      const created = await tplService.createStackFromTemplate(
        {
          templateId: template.id,
          name: STACK_NAME,
          parameterValues: {},
        },
        SYSTEM_USER,
      );
      stackId = created.id;
      log.info({ stackId, templateName: TEMPLATE_NAME }, "egress-fw-agent stack created from template");
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to create egress-fw-agent stack from template",
      );
      return { stackId: null, applyDispatched: false, reason: "create failed" };
    }
  }

  if (!autoStart) {
    log.info({ stackId }, "egress-fw-agent auto-start disabled; stack created but not applied");
    return { stackId, applyDispatched: false, reason: "auto-start disabled" };
  }

  // Apply in the background — never block boot on it. This is the part
  // that needs NATS up and Vault unsealed; the legacy `ensureFwAgent`
  // didn't have that constraint (it was a raw container create), so the
  // user-perceived boot time may be slightly slower on first install.
  // Subsequent boots see the stack already-applied and short-circuit
  // out of `reconciler.apply` via the no-op plan.
  void applyFwAgentStackInBackground(prisma, stackId);
  return { stackId, applyDispatched: true, reason: null };
}

async function applyFwAgentStackInBackground(
  prisma: PrismaClient,
  stackId: string,
): Promise<void> {
  // Wait for the bus, but don't make this terminal — `reconciler.apply`
  // re-checks NATS readiness in the orchestrator phase and surfaces a
  // clean error if it's still not up. Catch the timeout silently here:
  // the goal is just to give the bus a head start on a cold-boot worktree.
  try {
    await NatsBus.getInstance().ready({ timeoutMs: NATS_READY_TIMEOUT_MS });
  } catch {
    // Pass through — the apply will surface the real error.
  }

  try {
    const { reconciler } = await buildStackOperationServices();
    const plan = await reconciler.plan(stackId);

    // If every action is `no-op`, we're already in sync — short-circuit
    // before invoking the heavier vault/nats phases. Saves boot time on
    // the warm path (every boot after the first).
    const hasWork = plan.actions.some((a) => a.action !== "no-op")
      || (plan.resourceActions ?? []).some((r) => r.action !== "no-op");
    if (!hasWork) {
      log.info({ stackId }, "egress-fw-agent stack already in sync — no-op");
      return;
    }

    const vaultPhase = await runStackVaultApplyPhase(prisma, stackId, {
      triggeredBy: SYSTEM_USER,
      requireVaultReady: true,
    });
    if (vaultPhase.status === "error") {
      log.warn(
        { stackId, err: vaultPhase.error },
        "egress-fw-agent stack: vault apply phase failed (non-fatal; user can retry from UI)",
      );
      return;
    }
    const natsPhase = await runStackNatsApplyPhase(prisma, stackId, {
      triggeredBy: SYSTEM_USER,
      requireNatsReady: true,
    });
    if (natsPhase.status === "error") {
      log.warn(
        { stackId, err: natsPhase.error },
        "egress-fw-agent stack: NATS apply phase failed (non-fatal; user can retry from UI)",
      );
      return;
    }

    await reconciler.apply(stackId, { triggeredBy: SYSTEM_USER, plan });
    log.info({ stackId }, "egress-fw-agent stack applied at boot");
  } catch (err) {
    log.warn(
      { stackId, err: err instanceof Error ? err.message : String(err) },
      "egress-fw-agent stack auto-apply failed (non-fatal; user can retry from UI)",
    );
  }
}
