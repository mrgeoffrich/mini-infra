import { PrismaClient } from "@prisma/client";
import { StackParameterDefinition, StackParameterValue } from "@mini-infra/types";
import { BUILTIN_STACKS } from "./builtin";
import { BuiltinStackDefinition } from "./builtin/types";
import { servicesLogger } from "../../lib/logger-factory";
import { toServiceCreateInput, mergeParameterValues } from "./utils";

export async function syncBuiltinStacks(prisma: PrismaClient): Promise<void> {
  const log = servicesLogger().child({ operation: "builtin-stack-sync" });

  // 1. Sync host-scoped stacks (once globally)
  const hostStacks = BUILTIN_STACKS.filter((s) => s.scope === "host");
  for (const builtin of hostStacks) {
    try {
      await syncHostStack(prisma, builtin, log);
    } catch (error) {
      log.error(
        { error, stackName: builtin.name },
        "Failed to sync host-scoped built-in stack"
      );
    }
  }

  // 2. Sync environment-scoped stacks (per environment)
  const envStacks = BUILTIN_STACKS.filter((s) => s.scope === "environment");
  if (envStacks.length > 0) {
    const environments = await prisma.environment.findMany({
      select: { id: true },
    });

    log.info(
      { environmentCount: environments.length },
      "Syncing environment-scoped built-in stacks"
    );

    for (const env of environments) {
      for (const builtin of envStacks) {
        try {
          await syncOneStack(prisma, env.id, builtin, log);
        } catch (error) {
          log.error(
            { error, stackName: builtin.name, environmentId: env.id },
            "Failed to sync built-in stack"
          );
        }
      }
    }
  }

  // 3. Clean up orphaned per-environment monitoring stacks from old sync logic
  await cleanupOrphanedMonitoringStacks(prisma, log);

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

  const envStacks = BUILTIN_STACKS.filter((s) => s.scope === "environment");
  for (const builtin of envStacks) {
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

async function syncHostStack(
  prisma: PrismaClient,
  builtin: BuiltinStackDefinition,
  log: ReturnType<typeof servicesLogger>
): Promise<void> {
  const existing = await prisma.stack.findFirst({
    where: { name: builtin.name, environmentId: null },
  });

  if (!existing) {
    log.info({ stackName: builtin.name }, "Creating host-scoped built-in stack");
    const definition = await builtin.resolve({ prisma });
    const paramDefs = (definition.parameters ?? []) as StackParameterDefinition[];
    const defaultValues = mergeParameterValues(paramDefs, {});

    await prisma.stack.create({
      data: {
        name: definition.name,
        description: definition.description ?? null,
        // environmentId omitted → NULL
        version: 1,
        status: "undeployed",
        builtinVersion: builtin.builtinVersion,
        parameters: paramDefs.length > 0 ? (paramDefs as any) : undefined,
        parameterValues: Object.keys(defaultValues).length > 0 ? (defaultValues as any) : undefined,
        networks: definition.networks as any,
        volumes: definition.volumes as any,
        services: {
          create: definition.services.map(toServiceCreateInput),
        },
      },
    });
    return;
  }

  if (existing.builtinVersion === null) {
    log.debug(
      { stackName: builtin.name },
      "Skipping user-created stack with built-in name"
    );
    return;
  }

  if (existing.builtinVersion >= builtin.builtinVersion) {
    log.debug(
      { stackName: builtin.name, version: existing.builtinVersion },
      "Host-scoped built-in stack is up to date"
    );
    return;
  }

  log.info(
    {
      stackName: builtin.name,
      oldVersion: existing.builtinVersion,
      newVersion: builtin.builtinVersion,
    },
    "Updating host-scoped built-in stack definition"
  );

  const definition = await builtin.resolve({ prisma });
  const paramDefs = (definition.parameters ?? []) as StackParameterDefinition[];
  // Preserve existing user-set parameter values, fill in defaults for new params
  const existingValues = (existing.parameterValues as unknown as Record<string, StackParameterValue>) ?? {};
  const mergedValues = mergeParameterValues(paramDefs, existingValues);

  await prisma.$transaction(async (tx) => {
    await tx.stackService.deleteMany({
      where: { stackId: existing.id },
    });

    await tx.stack.update({
      where: { id: existing.id },
      data: {
        description: definition.description ?? null,
        version: existing.version + 1,
        status: "pending",
        builtinVersion: builtin.builtinVersion,
        parameters: paramDefs.length > 0 ? (paramDefs as any) : undefined,
        parameterValues: Object.keys(mergedValues).length > 0 ? (mergedValues as any) : undefined,
        networks: definition.networks as any,
        volumes: definition.volumes as any,
        services: {
          create: definition.services.map(toServiceCreateInput),
        },
      },
    });
  });
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
    const paramDefs = (definition.parameters ?? []) as StackParameterDefinition[];
    const defaultValues = mergeParameterValues(paramDefs, {});

    await prisma.stack.create({
      data: {
        name: definition.name,
        description: definition.description ?? null,
        environmentId,
        version: 1,
        status: "undeployed",
        builtinVersion: builtin.builtinVersion,
        parameters: paramDefs.length > 0 ? (paramDefs as any) : undefined,
        parameterValues: Object.keys(defaultValues).length > 0 ? (defaultValues as any) : undefined,
        networks: definition.networks as any,
        volumes: definition.volumes as any,
        services: {
          create: definition.services.map(toServiceCreateInput),
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
  const paramDefs = (definition.parameters ?? []) as StackParameterDefinition[];
  // Preserve existing user-set parameter values, fill in defaults for new params
  const existingValues = (existing.parameterValues as unknown as Record<string, StackParameterValue>) ?? {};
  const mergedValues = mergeParameterValues(paramDefs, existingValues);

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
        parameters: paramDefs.length > 0 ? (paramDefs as any) : undefined,
        parameterValues: Object.keys(mergedValues).length > 0 ? (mergedValues as any) : undefined,
        networks: definition.networks as any,
        volumes: definition.volumes as any,
        services: {
          create: definition.services.map(toServiceCreateInput),
        },
      },
    });
  });
}

async function cleanupOrphanedMonitoringStacks(
  prisma: PrismaClient,
  log: ReturnType<typeof servicesLogger>
): Promise<void> {
  // Remove per-environment monitoring stacks created by old sync logic
  // (monitoring is now host-scoped, not per-environment)
  const orphaned = await prisma.stack.findMany({
    where: {
      name: "monitoring",
      environmentId: { not: null },
      builtinVersion: { not: null },
      status: "undeployed",
    },
    select: { id: true },
  });

  if (orphaned.length > 0) {
    log.info(
      { count: orphaned.length },
      "Cleaning up orphaned per-environment monitoring stacks"
    );
    for (const s of orphaned) {
      await prisma.stack.delete({ where: { id: s.id } });
    }
  }
}
