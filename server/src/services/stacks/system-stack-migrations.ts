import type { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";

/**
 * One-time backfill migrations that run after the bundle sync on every boot.
 * Each migration is idempotent — running it multiple times produces the same
 * result. Add new migrations here; do NOT inline them in the apply pipeline.
 */
export async function runSystemStackMigrations(prisma: PrismaClient): Promise<void> {
  const log = getLogger("stacks", "system-stack-migrations");

  await migrateEnvironmentNetworksToInfraResources(prisma, log);

  log.debug("System stack migrations complete");
}

/**
 * Backfill InfraResource records from existing EnvironmentNetwork data.
 * Maps 'applications' networks to the haproxy stack and 'tunnel' networks to
 * the cloudflare-tunnel stack. Idempotent — upserts so it can run on every
 * startup safely.
 */
async function migrateEnvironmentNetworksToInfraResources(
  prisma: PrismaClient,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const envNetworks = await prisma.environmentNetwork.findMany({
    where: { purpose: { in: ["applications", "tunnel"] } },
  });

  if (envNetworks.length === 0) return;

  let migrated = 0;

  for (const en of envNetworks) {
    const stackName = en.purpose === "applications" ? "haproxy" : "cloudflare-tunnel";
    const owningStack = await prisma.stack.findFirst({
      where: {
        name: stackName,
        environmentId: en.environmentId,
        status: { not: "removed" },
      },
      select: { id: true },
    });

    try {
      await prisma.infraResource.upsert({
        where: {
          type_purpose_scope_environmentId: {
            type: "docker-network",
            purpose: en.purpose,
            scope: "environment",
            environmentId: en.environmentId,
          },
        },
        create: {
          type: "docker-network",
          purpose: en.purpose,
          scope: "environment",
          environmentId: en.environmentId,
          stackId: owningStack?.id ?? null,
          name: en.name,
        },
        update: {},
      });
      migrated++;
    } catch (err) {
      log.warn(
        {
          purpose: en.purpose,
          environmentId: en.environmentId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to migrate EnvironmentNetwork to InfraResource",
      );
    }
  }

  if (migrated > 0) {
    log.info(
      { migrated, total: envNetworks.length },
      "Backfilled InfraResource records from EnvironmentNetwork",
    );
  }
}
