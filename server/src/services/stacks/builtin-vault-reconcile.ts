import type { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { runStackVaultReconciler } from "./stack-vault-reconciler";
import { vaultServicesReady } from "../vault/vault-services";
import type { LoadedTemplate } from "./template-file-loader";
import type {
  TemplateInputDeclaration,
  TemplateVaultAppRole,
  TemplateVaultKv,
  TemplateVaultPolicy,
} from "@mini-infra/types";

/**
 * Run the Vault reconciler for every system stack whose current template
 * version declares a non-empty vault section.
 *
 * Called from builtin-stack-sync.ts when BUNDLES_DRIVE_BUILTIN=true.
 * Failures are non-fatal — a failed reconcile is logged and the boot
 * sequence continues. Service reconcile is NOT triggered here.
 */
export async function runBuiltinVaultReconcile(
  prisma: PrismaClient,
  templateByName: Map<string, { id: string; template: LoadedTemplate }>,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  if (!vaultServicesReady()) {
    log.info("Vault services not ready — skipping builtin vault reconcile");
    return;
  }

  const builtinStacks = await prisma.stack.findMany({
    where: { builtinVersion: { not: null }, status: { not: "removed" } },
    select: { id: true, name: true, templateId: true, templateVersion: true },
  });

  for (const stack of builtinStacks) {
    const entry = templateByName.get(stack.name);
    if (!entry) continue;

    const template = entry.template;
    const vaultSection = template.vault;

    const hasVault =
      (vaultSection?.policies?.length ?? 0) > 0 ||
      (vaultSection?.appRoles?.length ?? 0) > 0 ||
      (vaultSection?.kv?.length ?? 0) > 0;

    if (!hasVault) continue;

    try {
      await reconcileBuiltinStackVault(prisma, stack.id, stack.name, template, log);
    } catch (err) {
      log.error(
        {
          stackId: stack.id,
          stackName: stack.name,
          error: err instanceof Error ? err.message : String(err),
        },
        "Builtin vault reconcile failed for stack (non-fatal)",
      );
    }
  }
}

async function reconcileBuiltinStackVault(
  prisma: PrismaClient,
  stackId: string,
  stackName: string,
  template: LoadedTemplate,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  // Use the template version stored on the stack row, falling back to the
  // disk version. System templates typically keep these in sync.
  const stackRow = await prisma.stack.findUnique({
    where: { id: stackId },
    select: { templateId: true, templateVersion: true, services: { select: { id: true, serviceName: true } } },
  });
  if (!stackRow?.templateId || stackRow.templateVersion == null) return;

  // Load vault fields from the persisted template version in the DB so we use
  // exactly what was upserted, not stale in-memory disk state.
  const dbTemplateVersion = await prisma.stackTemplateVersion.findFirst({
    where: { templateId: stackRow.templateId, version: stackRow.templateVersion },
    select: {
      version: true,
      inputs: true,
      vaultPolicies: true,
      vaultAppRoles: true,
      vaultKv: true,
      services: { select: { serviceName: true, vaultAppRoleRef: true } },
    },
  });

  if (!dbTemplateVersion) {
    log.warn({ stackName, stackId }, "No DB template version found for builtin stack — skipping vault reconcile");
    return;
  }

  const policies = (dbTemplateVersion.vaultPolicies as TemplateVaultPolicy[] | null) ?? [];
  const appRoles = (dbTemplateVersion.vaultAppRoles as TemplateVaultAppRole[] | null) ?? [];
  const kv = (dbTemplateVersion.vaultKv as TemplateVaultKv[] | null) ?? [];
  const inputs = (dbTemplateVersion.inputs as TemplateInputDeclaration[] | null) ?? [];

  const hasVault = policies.length > 0 || appRoles.length > 0 || kv.length > 0;
  if (!hasVault) return;

  log.info({ stackName, stackId, templateVersion: dbTemplateVersion.version }, "Running vault reconcile for builtin stack");

  const result = await runStackVaultReconciler(prisma, stackId, {
    stackId,
    templateVersion: dbTemplateVersion.version,
    inputs,
    vault: { policies, appRoles, kv },
    userId: undefined,
  });

  if (result.status === "error") {
    log.error(
      { stackName, stackId, error: result.error },
      "Vault reconcile returned error for builtin stack",
    );
    return;
  }

  if (result.status === "noop" || !result.snapshot) {
    log.debug({ stackName, stackId }, "Vault reconcile noop — no changes");
    return;
  }

  // Commit the snapshot and any service AppRole ID writes atomically.
  const templateRefByServiceName = new Map<string, string>(
    dbTemplateVersion.services
      .filter((s) => s.vaultAppRoleRef != null)
      .map((s) => [s.serviceName, s.vaultAppRoleRef as string]),
  );

  const serviceUpdates = (stackRow.services ?? [])
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
        lastAppliedVaultSnapshot: result.snapshot as unknown as import("../../generated/prisma/client").Prisma.InputJsonValue,
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

  log.info(
    {
      stackName,
      stackId,
      appliedAppRoles: Object.keys(result.appliedAppRoleIdByName).length,
      servicesBound: serviceUpdates.length,
    },
    "Builtin vault reconcile applied",
  );
}
