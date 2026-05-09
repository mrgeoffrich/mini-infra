/**
 * Stack-level boot bootstrap for the egress-fw-agent.
 *
 * Replaces the legacy host-singleton `ensureFwAgent()` flow (ALT-27). The
 * fw-agent is now a host-scoped stack template (`server/templates/egress-
 * fw-agent/`) that runs in `network_mode: host` with NATS_URL/NATS_CREDS
 * injected via dynamicEnv.
 *
 * **Phase 2 of split-vault-nats:** the boot-time apply dispatch was removed.
 * The fw-agent template now declares a cross-stack `requires` on the host
 * `nats` stack being `synced`, which transitively requires Vault to be
 * bootstrapped. The apply is deferred to whatever caller is responsible for
 * walking through the chain in order — the dev seeder runs the chain
 * (vault → bootstrap → nats → fw-agent) explicitly; in production the
 * operator triggers the apply from the egress-fw-agent settings card after
 * NATS is up. The prereq gate produces a clear `PREREQUISITES_NOT_MET` if
 * the apply is fired before NATS is synced.
 *
 * What this module still does at boot:
 *
 *   1. **Ensure the stack DB row exists.** Idempotent: looks up the
 *      stack by templateId; if missing and the system template is
 *      already on disk, calls `StackTemplateService.createStackFromTemplate`
 *      to materialize it. No apply, no Docker side effects.
 *
 * Auto-start opt-out: setting `egress-fw-agent.auto_start=false` in
 * SystemSettings preserves the legacy "user manages it" mode. The stack
 * row is still created so the UI has something to show.
 */

import type { PrismaClient } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import { StackTemplateService } from "../stacks/stack-template-service";

const log = getLogger("stacks", "fw-agent-stack-bootstrap");

const TEMPLATE_NAME = "egress-fw-agent";
const STACK_NAME = "egress-fw-agent";
const SETTINGS_CATEGORY = "egress-fw-agent";
const AUTO_START_KEY = "auto_start";
const SYSTEM_USER = "system";

export interface BootstrapFwAgentStackResult {
  /** Stack row id; null when no stack was created (template missing). */
  stackId: string | null;
  /** Whether the apply was fired in the background. Always false post-Phase-2. */
  applyDispatched: false;
  /** Short human-readable reason on no-op paths. */
  reason: string | null;
}

/**
 * Idempotent boot entry point. Safe to call from `server.ts` and from
 * the docker-reconnect callback. A second call with the stack already
 * created is a cheap series of DB lookups — no side effects.
 *
 * Phase 2 of split-vault-nats: this no longer dispatches an apply. The
 * cross-stack-prereqs system on the egress-fw-agent template handles
 * "NATS not yet synced" as a structured `PREREQUISITES_NOT_MET` failure
 * when the operator (or the dev seeder) eventually triggers the apply.
 */
export async function bootstrapFwAgentStack(
  prisma: PrismaClient,
): Promise<BootstrapFwAgentStackResult> {
  // Auto-start opt-out is read for parity with the legacy host-singleton, but
  // post-Phase-2 it only affects a downstream caller's decision to apply —
  // we always create the row so the UI has something to render.
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

  // Phase 2 split-vault-nats: apply is deferred to operator/seeder via the
  // cross-stack-prereqs system. Always return applyDispatched: false.
  const reason = autoStart
    ? "deferred to operator/seeder per cross-stack-prereqs design"
    : "auto-start disabled";
  log.info({ stackId, autoStart }, "egress-fw-agent stack ready (apply deferred)");
  return { stackId, applyDispatched: false, reason };
}
