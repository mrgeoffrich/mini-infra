import * as fs from "fs";
import * as path from "path";
import { PrismaClient, Prisma } from "../../generated/prisma/client";
import { StackParameterDefinition, StackParameterValue, StackServiceDefinition, StackDefinition } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { toServiceCreateInput, mergeParameterValues } from "./utils";
import { StackTemplateService } from "./stack-template-service";
import { discoverTemplates, LoadedTemplate } from "./template-file-loader";

// Resolve the templates directory relative to the server root.
// In dev, __dirname is server/src/services/stacks/ (3 levels up to server/).
// In prod, __dirname is server/dist/server/src/services/stacks/ (5 levels up to server/).
// Use a reliable anchor: walk up until we find the templates/ sibling directory.
function findTemplatesDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "templates");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "../../../templates");
}

const TEMPLATES_DIR = findTemplatesDir();

export async function syncBuiltinStacks(prisma: PrismaClient): Promise<void> {
  const log = getLogger("stacks", "builtin-stack-sync").child({ operation: "builtin-stack-sync" });
  const templateService = new StackTemplateService(prisma);

  // Discover and validate all template files
  let templates: LoadedTemplate[];
  try {
    templates = discoverTemplates(TEMPLATES_DIR);
    log.info(
      { count: templates.length, dir: TEMPLATES_DIR },
      "Discovered system template files"
    );
  } catch (error) {
    log.error({ error, dir: TEMPLATES_DIR }, "Failed to discover template files");
    return;
  }

  // 1. Sync host-scoped templates (template rows only — stacks are created on user deploy)
  const hostTemplates = templates.filter((t) => t.scope === "host");
  for (const template of hostTemplates) {
    try {
      await templateService.upsertSystemTemplate({
        name: template.name,
        displayName: template.displayName,
        scope: template.scope,
        category: template.category,
        builtinVersion: template.builtinVersion,
        definition: template.definition as unknown as StackDefinition,
        configFiles: template.configFiles,
      });
    } catch (error) {
      log.error(
        { error, stackName: template.name },
        "Failed to sync host-scoped system template"
      );
    }
  }

  // 2. Sync environment-scoped templates (per environment)
  const envTemplates = templates.filter((t) => t.scope === "environment");
  if (envTemplates.length > 0) {
    const environments = await prisma.environment.findMany({
      select: { id: true, networkType: true },
    });

    log.info(
      { environmentCount: environments.length },
      "Syncing environment-scoped system templates"
    );

    for (const env of environments) {
      for (const template of envTemplates) {
        try {
          const { templateId } = await templateService.upsertSystemTemplate({
            name: template.name,
            displayName: template.displayName,
            scope: template.scope,
            category: template.category,
            builtinVersion: template.builtinVersion,
            definition: template.definition as unknown as StackDefinition,
            configFiles: template.configFiles,
          });
          await syncStackFromTemplate(prisma, templateId, template, env.id, log, env.networkType);
        } catch (error) {
          log.error(
            { error, stackName: template.name, environmentId: env.id },
            "Failed to sync environment-scoped system template"
          );
        }
      }
    }
  }

  // 3. Clean up orphaned stacks from old sync logic
  await cleanupOrphanedStacks(prisma, templates, log);

  // 4. Backfill InfraResource records from existing EnvironmentNetwork data
  await migrateEnvironmentNetworksToInfraResources(prisma, log);

  log.info("Built-in stack sync complete");
}

export async function syncBuiltinStacksForEnvironment(
  prisma: PrismaClient,
  environmentId: string
): Promise<void> {
  const log = getLogger("stacks", "builtin-stack-sync").child({
    operation: "builtin-stack-sync",
    environmentId,
  });
  const templateService = new StackTemplateService(prisma);

  let templates: LoadedTemplate[];
  try {
    templates = discoverTemplates(TEMPLATES_DIR);
  } catch (error) {
    log.error({ error }, "Failed to discover template files");
    return;
  }

  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { networkType: true },
  });
  const networkType = environment?.networkType ?? "local";

  const envTemplates = templates.filter((t) => t.scope === "environment");
  for (const template of envTemplates) {
    try {
      const { templateId } = await templateService.upsertSystemTemplate({
        name: template.name,
        displayName: template.displayName,
        scope: template.scope,
        category: template.category,
        builtinVersion: template.builtinVersion,
        definition: template.definition as unknown as StackDefinition,
        configFiles: template.configFiles,
      });
      await syncStackFromTemplate(prisma, templateId, template, environmentId, log, networkType);
    } catch (error) {
      log.error(
        { error, stackName: template.name },
        "Failed to sync system template"
      );
    }
  }
}

/**
 * Sync a Stack row from a loaded template. Creates the stack if it doesn't exist,
 * updates it if the template version has advanced, and backfills templateId
 * on existing stacks that don't have it set yet.
 */
async function syncStackFromTemplate(
  prisma: PrismaClient,
  templateId: string,
  template: LoadedTemplate,
  environmentId: string | null,
  log: ReturnType<typeof getLogger>,
  networkType: string = "local"
): Promise<void> {
  const { definition } = template;
  const networkTypeDefaults = definition.networkTypeDefaults ?? {};
  const parameterOverrides = networkTypeDefaults[networkType] ?? {};

  const existing = await prisma.stack.findFirst({
    where: { name: template.name, environmentId },
  });

  // No DB record → create
  if (!existing) {
    log.info({ stackName: template.name }, "Creating built-in stack from template");
    const paramDefs = (definition.parameters ?? []) as StackParameterDefinition[];
    const defaultValues = mergeParameterValues(paramDefs, parameterOverrides);

    const serviceCreates: Prisma.StackServiceCreateWithoutStackInput[] =
      (definition.services as StackServiceDefinition[]).map(toServiceCreateInput) as unknown as Prisma.StackServiceCreateWithoutStackInput[];

    await prisma.stack.create({
      data: {
        name: definition.name,
        description: definition.description ?? null,
        environmentId,
        version: 1,
        status: "undeployed",
        builtinVersion: template.builtinVersion,
        templateId,
        templateVersion: template.builtinVersion,
        parameters: paramDefs.length > 0 ? (paramDefs as unknown as Prisma.InputJsonValue) : undefined,
        parameterValues: Object.keys(defaultValues).length > 0 ? (defaultValues as unknown as Prisma.InputJsonValue) : undefined,
        resourceOutputs: definition.resourceOutputs ? (definition.resourceOutputs as unknown as Prisma.InputJsonValue) : undefined,
        resourceInputs: definition.resourceInputs ? (definition.resourceInputs as unknown as Prisma.InputJsonValue) : undefined,
        networks: definition.networks as unknown as Prisma.InputJsonValue,
        volumes: definition.volumes as unknown as Prisma.InputJsonValue,
        services: {
          create: serviceCreates,
        },
      },
    });
    return;
  }

  // builtinVersion is null → user-created stack with same name, skip
  if (existing.builtinVersion === null) {
    log.debug(
      { stackName: template.name },
      "Skipping user-created stack with built-in name"
    );
    return;
  }

  // Backfill templateId if not set (migration from pre-template stacks)
  if (!existing.templateId) {
    await prisma.stack.update({
      where: { id: existing.id },
      data: {
        templateId,
        templateVersion: existing.builtinVersion,
      },
    });
    log.info(
      { stackName: template.name },
      "Backfilled templateId on existing built-in stack"
    );
  }

  // Apply environment-driven parameter overrides to existing non-running stacks
  // (e.g. expose-on-host=false for internet-facing HAProxy)
  const canApplyOverrides = ["undeployed", "error", "pending", "removed"].includes(existing.status);
  if (Object.keys(parameterOverrides).length > 0 && canApplyOverrides) {
    const existingValues = (existing.parameterValues as unknown as Record<string, StackParameterValue>) ?? {};
    const needsUpdate = Object.entries(parameterOverrides).some(
      ([key, value]) => existingValues[key] !== value
    );
    if (needsUpdate) {
      const updatedValues = { ...existingValues, ...parameterOverrides };
      await prisma.stack.update({
        where: { id: existing.id },
        data: { parameterValues: updatedValues as unknown as Prisma.InputJsonValue },
      });
      log.info(
        { stackName: template.name, overrides: parameterOverrides },
        "Applied environment parameter overrides to existing stack"
      );
    }
  }

  // DB version matches → no-op
  if (existing.builtinVersion >= template.builtinVersion) {
    log.debug(
      { stackName: template.name, version: existing.builtinVersion },
      "Built-in stack is up to date"
    );
    return;
  }

  // Template version is newer → update
  log.info(
    {
      stackName: template.name,
      oldVersion: existing.builtinVersion,
      newVersion: template.builtinVersion,
    },
    "Updating built-in stack definition"
  );

  const paramDefs = (definition.parameters ?? []) as StackParameterDefinition[];
  const existingValues = (existing.parameterValues as unknown as Record<string, StackParameterValue>) ?? {};
  const mergedValues = mergeParameterValues(paramDefs, { ...existingValues, ...parameterOverrides });

  await prisma.$transaction(async (tx) => {
    await tx.stackService.deleteMany({
      where: { stackId: existing.id },
    });

    const serviceCreates: Prisma.StackServiceCreateWithoutStackInput[] =
      (definition.services as StackServiceDefinition[]).map(toServiceCreateInput) as unknown as Prisma.StackServiceCreateWithoutStackInput[];

    await tx.stack.update({
      where: { id: existing.id },
      data: {
        description: definition.description ?? null,
        version: existing.version + 1,
        status: "pending",
        builtinVersion: template.builtinVersion,
        templateId,
        templateVersion: template.builtinVersion,
        parameters: paramDefs.length > 0 ? (paramDefs as unknown as Prisma.InputJsonValue) : undefined,
        parameterValues: Object.keys(mergedValues).length > 0 ? (mergedValues as unknown as Prisma.InputJsonValue) : undefined,
        resourceOutputs: definition.resourceOutputs ? (definition.resourceOutputs as unknown as Prisma.InputJsonValue) : undefined,
        resourceInputs: definition.resourceInputs ? (definition.resourceInputs as unknown as Prisma.InputJsonValue) : undefined,
        networks: definition.networks as unknown as Prisma.InputJsonValue,
        volumes: definition.volumes as unknown as Prisma.InputJsonValue,
        services: {
          create: serviceCreates,
        },
      },
    });
  });
}

async function cleanupOrphanedStacks(
  prisma: PrismaClient,
  templates: LoadedTemplate[],
  log: ReturnType<typeof getLogger>
): Promise<void> {
  // Clean up orphaned per-environment monitoring stacks (from old sync logic)
  const orphanedMonitoring = await prisma.stack.findMany({
    where: {
      name: "monitoring",
      environmentId: { not: null },
      builtinVersion: { not: null },
      status: "undeployed",
    },
    select: { id: true },
  });

  if (orphanedMonitoring.length > 0) {
    log.info(
      { count: orphanedMonitoring.length },
      "Cleaning up orphaned per-environment monitoring stacks"
    );
    for (const s of orphanedMonitoring) {
      await prisma.stack.delete({ where: { id: s.id } });
    }
  }

  // Clean up orphaned host-level stacks for environment-scoped templates
  const envScopedNames = templates
    .filter((t) => t.scope === "environment")
    .map((t) => t.name);

  if (envScopedNames.length > 0) {
    const orphanedHostLevel = await prisma.stack.findMany({
      where: {
        name: { in: envScopedNames },
        environmentId: null,
        builtinVersion: { not: null },
        status: "undeployed",
      },
      select: { id: true, name: true },
    });

    if (orphanedHostLevel.length > 0) {
      log.info(
        { count: orphanedHostLevel.length, stacks: orphanedHostLevel.map((s) => s.name) },
        "Cleaning up orphaned host-level stacks for environment-scoped templates"
      );
      for (const s of orphanedHostLevel) {
        await prisma.stack.delete({ where: { id: s.id } });
      }
    }
  }
}

/**
 * Backfill InfraResource records from existing EnvironmentNetwork data.
 * Maps 'applications' networks to the haproxy stack and 'tunnel' networks to the cloudflare-tunnel stack.
 * Idempotent — upserts so it can run on every startup safely.
 */
async function migrateEnvironmentNetworksToInfraResources(
  prisma: PrismaClient,
  log: ReturnType<typeof getLogger>
): Promise<void> {
  const envNetworks = await prisma.environmentNetwork.findMany({
    where: { purpose: { in: ['applications', 'tunnel'] } },
  });

  if (envNetworks.length === 0) return;

  let migrated = 0;

  for (const en of envNetworks) {
    // Find the owning stack: haproxy for 'applications', cloudflare-tunnel for 'tunnel'
    const stackName = en.purpose === 'applications' ? 'haproxy' : 'cloudflare-tunnel';
    const owningStack = await prisma.stack.findFirst({
      where: { name: stackName, environmentId: en.environmentId, status: { not: 'removed' } },
      select: { id: true },
    });

    try {
      await prisma.infraResource.upsert({
        where: {
          type_purpose_scope_environmentId: {
            type: 'docker-network',
            purpose: en.purpose,
            scope: 'environment',
            environmentId: en.environmentId,
          },
        },
        create: {
          type: 'docker-network',
          purpose: en.purpose,
          scope: 'environment',
          environmentId: en.environmentId,
          stackId: owningStack?.id ?? null,
          name: en.name,
        },
        update: {}, // Don't overwrite if already exists
      });
      migrated++;
    } catch (err) {
      log.warn(
        { purpose: en.purpose, environmentId: en.environmentId, error: (err instanceof Error ? err.message : String(err)) },
        'Failed to migrate EnvironmentNetwork to InfraResource'
      );
    }
  }

  if (migrated > 0) {
    log.info({ migrated, total: envNetworks.length }, 'Backfilled InfraResource records from EnvironmentNetwork');
  }
}
