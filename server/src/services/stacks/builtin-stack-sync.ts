import { Prisma, PrismaClient } from "@prisma/client";
import { BUILTIN_STACKS } from "./builtin";
import { BuiltinStackDefinition } from "./builtin/types";
import { servicesLogger } from "../../lib/logger-factory";

export async function syncBuiltinStacks(prisma: PrismaClient): Promise<void> {
  const log = servicesLogger().child({ operation: "builtin-stack-sync" });

  const environments = await prisma.environment.findMany({
    select: { id: true },
  });

  log.info(
    { environmentCount: environments.length },
    "Syncing built-in stacks for all environments"
  );

  for (const env of environments) {
    await syncBuiltinStacksForEnvironment(prisma, env.id);
  }

  log.info("Built-in stack sync complete");
}

export async function syncBuiltinStacksForEnvironment(
  prisma: PrismaClient,
  environmentId: string
): Promise<void> {
  const log = servicesLogger().child({
    operation: "builtin-stack-sync",
    environmentId,
  });

  for (const builtin of BUILTIN_STACKS) {
    try {
      await syncOneStack(prisma, environmentId, builtin, log);
    } catch (error) {
      log.error(
        { error, stackName: builtin.name },
        "Failed to sync built-in stack"
      );
    }
  }
}

async function syncOneStack(
  prisma: PrismaClient,
  environmentId: string,
  builtin: BuiltinStackDefinition,
  log: ReturnType<typeof servicesLogger>
): Promise<void> {
  const existing = await prisma.stack.findFirst({
    where: { name: builtin.name, environmentId },
  });

  // No DB record → create
  if (!existing) {
    log.info({ stackName: builtin.name }, "Creating built-in stack");
    const definition = await builtin.resolve({ environmentId, prisma });

    await prisma.stack.create({
      data: {
        name: definition.name,
        description: definition.description ?? null,
        environmentId,
        version: 1,
        status: "undeployed",
        builtinVersion: builtin.builtinVersion,
        networks: definition.networks as any,
        volumes: definition.volumes as any,
        services: {
          create: definition.services.map((s) => ({
            serviceName: s.serviceName,
            serviceType: s.serviceType,
            dockerImage: s.dockerImage,
            dockerTag: s.dockerTag,
            containerConfig: s.containerConfig as any,
            configFiles: (s.configFiles ?? []) as any,
            initCommands: (s.initCommands ?? []) as any,
            dependsOn: s.dependsOn,
            order: s.order,
            routing: s.routing ? (s.routing as any) : Prisma.DbNull,
          })),
        },
      },
    });
    return;
  }

  // builtinVersion is null → user-created stack with same name, skip
  if (existing.builtinVersion === null) {
    log.debug(
      { stackName: builtin.name },
      "Skipping user-created stack with built-in name"
    );
    return;
  }

  // DB version matches → no-op
  if (existing.builtinVersion >= builtin.builtinVersion) {
    log.debug(
      { stackName: builtin.name, version: existing.builtinVersion },
      "Built-in stack is up to date"
    );
    return;
  }

  // Code version is newer → update
  log.info(
    {
      stackName: builtin.name,
      oldVersion: existing.builtinVersion,
      newVersion: builtin.builtinVersion,
    },
    "Updating built-in stack definition"
  );

  const definition = await builtin.resolve({ environmentId, prisma });

  await prisma.$transaction(async (tx) => {
    // Delete old services
    await tx.stackService.deleteMany({
      where: { stackId: existing.id },
    });

    // Update stack with new definition
    await tx.stack.update({
      where: { id: existing.id },
      data: {
        description: definition.description ?? null,
        version: existing.version + 1,
        status: "pending",
        builtinVersion: builtin.builtinVersion,
        networks: definition.networks as any,
        volumes: definition.volumes as any,
        services: {
          create: definition.services.map((s) => ({
            serviceName: s.serviceName,
            serviceType: s.serviceType,
            dockerImage: s.dockerImage,
            dockerTag: s.dockerTag,
            containerConfig: s.containerConfig as any,
            configFiles: (s.configFiles ?? []) as any,
            initCommands: (s.initCommands ?? []) as any,
            dependsOn: s.dependsOn,
            order: s.order,
            routing: s.routing ? (s.routing as any) : Prisma.DbNull,
          })),
        },
      },
    });
  });
}
