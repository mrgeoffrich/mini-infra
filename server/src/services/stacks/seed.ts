import { PrismaClient } from "@prisma/client";
import { seedMonitoringStack } from "./seed-monitoring-stack";
import { seedHAProxyStack } from "./seed-haproxy-stack";
import { servicesLogger } from "../../lib/logger-factory";

export async function seedStacksForEnvironment(
  prisma: PrismaClient,
  environmentId: string
): Promise<void> {
  const log = servicesLogger().child({
    operation: "seed-stacks",
    environmentId,
  });

  log.info("Seeding stacks for environment");

  await seedMonitoringStack(prisma, environmentId);
  await seedHAProxyStack(prisma, environmentId);

  log.info("Stack seeding complete");
}
