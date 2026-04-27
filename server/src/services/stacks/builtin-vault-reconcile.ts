import type { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { runStackVaultApplyPhase } from "./stack-vault-apply-orchestrator";
import { vaultServicesReady } from "../vault/vault-services";
import type { LoadedTemplate } from "./template-file-loader";

export const BUNDLES_DRIVE_BUILTIN = process.env.BUNDLES_DRIVE_BUILTIN === "true";

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
    select: { id: true, name: true },
  });

  for (const stack of builtinStacks) {
    const entry = templateByName.get(stack.name);
    if (!entry) continue;

    const vaultSection = entry.template.vault;
    const hasVault =
      (vaultSection?.policies?.length ?? 0) > 0 ||
      (vaultSection?.appRoles?.length ?? 0) > 0 ||
      (vaultSection?.kv?.length ?? 0) > 0;
    if (!hasVault) continue;

    try {
      const result = await runStackVaultApplyPhase(prisma, stack.id, {
        triggeredBy: undefined,
      });

      if (result.status === "error") {
        log.error(
          { stackName: stack.name, stackId: stack.id, error: result.error },
          "Vault reconcile returned error for builtin stack",
        );
      } else if (result.status === "applied") {
        log.info(
          {
            stackName: stack.name,
            stackId: stack.id,
            appliedAppRoles: result.appRolesMapped,
            servicesBound: result.servicesBound,
          },
          "Builtin vault reconcile applied",
        );
      } else {
        log.debug(
          { stackName: stack.name, stackId: stack.id, status: result.status },
          "Builtin vault reconcile no changes",
        );
      }
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
