/**
 * Stack apply — Vault phase orchestrator.
 *
 * Owns the workflow that wraps `runStackVaultReconciler`:
 *   1. Loads the stack's current `StackTemplateVersion` (vault sections + inputs
 *      + service `vaultAppRoleRef` mappings) from the DB.
 *   2. Short-circuits when the template has no vault section.
 *   3. Runs the reconciler.
 *   4. On a successful apply, transactionally commits the new snapshot blob and
 *      writes `StackService.vaultAppRoleId` for any service whose
 *      `vaultAppRoleRef` resolved to a concrete AppRole this run.
 *
 * Two callers exist — the user-initiated apply route and the boot-time builtin
 * reconcile loop. Both used to inline this logic; consolidating it here ensures
 * the same DB shape and the same transaction layout regardless of trigger.
 */

import type { PrismaClient } from "../../lib/prisma";
import { vaultServicesReady } from "../vault/vault-services";
import { runStackVaultReconciler } from "./stack-vault-reconciler";
import type { VaultServiceLoaders } from "./vault-services-loader";
import type {
  TemplateInputDeclaration,
  TemplateVaultAppRole,
  TemplateVaultKv,
  TemplateVaultPolicy,
} from "@mini-infra/types";

export type VaultApplyPhaseStatus = "applied" | "noop" | "skipped" | "error";

export interface VaultApplyPhaseResult {
  status: VaultApplyPhaseStatus;
  /** "applied" only — number of services that got a `vaultAppRoleId` written. */
  servicesBound?: number;
  /** "applied" only — count of distinct AppRole names mapped this run. */
  appRolesMapped?: number;
  /** "error" only — combined failure reason from the reconciler. */
  error?: string;
}

export interface VaultApplyPhaseOptions {
  /** User who triggered the apply (undefined for system-initiated runs). */
  triggeredBy: string | undefined;
  /**
   * When true, the orchestrator throws if Vault services are not initialised.
   * The user-initiated apply route uses this — Vault must be ready before a
   * user-triggered apply touches a vault-bearing template. Boot-time builtin
   * reconciles set this to false because Vault may legitimately not be ready
   * yet when the loop runs.
   */
  requireVaultReady?: boolean;
}

/**
 * Run the Vault phase for one stack apply.
 *
 * Returns:
 *   - `skipped`  — no template, no version, empty vault section, or Vault not
 *                  ready (when `requireVaultReady` is false).
 *   - `noop`     — reconciler ran but every resource already matched.
 *   - `applied`  — reconciler wrote at least one resource; snapshot + bindings
 *                  committed.
 *   - `error`    — reconciler failed; rollback (if any) has already run inside
 *                  the reconciler. The stack row's status/lastFailureReason are
 *                  set by the reconciler.
 *
 * Throws only when `requireVaultReady` is true and Vault is not initialised.
 */
export async function runStackVaultApplyPhase(
  prisma: PrismaClient,
  stackId: string,
  opts: VaultApplyPhaseOptions,
  serviceOverrides?: VaultServiceLoaders,
): Promise<VaultApplyPhaseResult> {
  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    select: {
      templateId: true,
      templateVersion: true,
      services: { select: { id: true, serviceName: true } },
    },
  });

  if (!stack?.templateId || stack.templateVersion == null) {
    return { status: "skipped" };
  }

  const templateVersion = await prisma.stackTemplateVersion.findFirst({
    where: { templateId: stack.templateId, version: stack.templateVersion },
    select: {
      version: true,
      inputs: true,
      vaultPolicies: true,
      vaultAppRoles: true,
      vaultKv: true,
      services: { select: { serviceName: true, vaultAppRoleRef: true } },
    },
  });

  if (!templateVersion) return { status: "skipped" };

  const policies = (templateVersion.vaultPolicies as TemplateVaultPolicy[] | null) ?? [];
  const appRoles = (templateVersion.vaultAppRoles as TemplateVaultAppRole[] | null) ?? [];
  const kv = (templateVersion.vaultKv as TemplateVaultKv[] | null) ?? [];
  const inputs = (templateVersion.inputs as TemplateInputDeclaration[] | null) ?? [];

  const hasVault = policies.length > 0 || appRoles.length > 0 || kv.length > 0;
  if (!hasVault) return { status: "skipped" };

  if (!vaultServicesReady()) {
    if (opts.requireVaultReady) {
      throw new Error("Vault services are not initialised; cannot run vault reconciliation phase");
    }
    return { status: "skipped" };
  }

  const result = await runStackVaultReconciler(
    prisma,
    stackId,
    {
      stackId,
      templateVersion: templateVersion.version,
      inputs,
      vault: { policies, appRoles, kv },
      userId: opts.triggeredBy,
    },
    serviceOverrides,
  );

  if (result.status === "error") {
    return { status: "error", error: result.error };
  }
  if (result.status === "noop" || !result.encryptedSnapshot) {
    return { status: "noop" };
  }

  const templateRefByServiceName = new Map<string, string>(
    templateVersion.services
      .filter((s) => s.vaultAppRoleRef != null)
      .map((s) => [s.serviceName, s.vaultAppRoleRef as string]),
  );

  const serviceUpdates = (stack.services ?? [])
    .map((svc) => {
      const ref = templateRefByServiceName.get(svc.serviceName);
      const concreteId = ref ? result.appliedAppRoleIdByName[ref] : undefined;
      return concreteId ? { id: svc.id, vaultAppRoleId: concreteId } : null;
    })
    .filter((u): u is { id: string; vaultAppRoleId: string } => u !== null);

  await prisma.$transaction([
    prisma.stack.update({
      where: { id: stackId },
      data: {
        lastAppliedVaultSnapshot: result.encryptedSnapshot,
        lastFailureReason: null,
      },
    }),
    ...serviceUpdates.map((u) =>
      prisma.stackService.update({
        where: { id: u.id },
        data: { vaultAppRoleId: u.vaultAppRoleId },
      }),
    ),
  ]);

  return {
    status: "applied",
    servicesBound: serviceUpdates.length,
    appRolesMapped: Object.keys(result.appliedAppRoleIdByName).length,
  };
}
