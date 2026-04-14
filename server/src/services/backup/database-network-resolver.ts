import { PrismaClient } from "../../generated/prisma/client";
import { servicesLogger } from "../../lib/logger-factory";

const LEGACY_NETWORK_NAME = "mini-infra-postgres-backup";

/**
 * Resolve the database management network name from InfraResource records.
 * Returns "mini-infra-database" if the dataplane-network stack has been deployed
 * with the database output, otherwise falls back to the legacy network name.
 */
export async function resolveDatabaseNetworkName(
  prisma: Pick<PrismaClient, "infraResource">,
): Promise<string> {
  try {
    const resource = await prisma.infraResource.findFirst({
      where: {
        type: "docker-network",
        purpose: "database",
        scope: "host",
        environmentId: null,
      },
    });
    if (resource) {
      return resource.name;
    }
  } catch (error) {
    servicesLogger().warn(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to resolve database network from InfraResource, using fallback",
    );
  }
  return LEGACY_NETWORK_NAME;
}
