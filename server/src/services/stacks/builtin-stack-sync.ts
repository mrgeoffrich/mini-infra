import * as fs from "fs";
import * as path from "path";
import { PrismaClient, Prisma } from "../../generated/prisma/client";
import { StackParameterDefinition, StackParameterValue, StackServiceDefinition, StackDefinition } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { toServiceCreateInput, mergeParameterValues } from "./utils";
import { StackTemplateService } from "./stack-template-service";
import { discoverTemplates, LoadedTemplate } from "./template-file-loader";
import { runSystemStackMigrations } from "./system-stack-migrations";
import { runBuiltinVaultReconcile } from "./builtin-vault-reconcile";

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

const BUNDLES_DRIVE_BUILTIN = process.env.BUNDLES_DRIVE_BUILTIN === "true";

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

  // 1. Upsert all system template rows (host + environment scoped) so the catalog
  // reflects every built-in template regardless of whether any environments exist yet.
  const templateByName = new Map<string, { id: string; template: LoadedTemplate }>();
  for (const template of templates) {
    try {
      const { templateId } = await templateService.upsertSystemTemplate({
        name: template.name,
        displayName: template.displayName,
        scope: template.scope,
        networkType: template.networkType ?? null,
        category: template.category,
        builtinVersion: template.builtinVersion,
        definition: template.definition as unknown as StackDefinition,
        configFiles: template.configFiles,
      });
      templateByName.set(template.name, { id: templateId, template });
    } catch (error) {
      log.error(
        { error, stackName: template.name, scope: template.scope },
        "Failed to sync system template"
      );
    }
  }

  // 2. Upgrade existing stacks that were instantiated from a system template
  // when the template version on disk has advanced. Stacks are never created
  // here — that happens on explicit user action (template instantiation).
  await upgradeExistingStacksForTemplates(prisma, templateByName, log);

  // 3. When the feature flag is on, run the Vault reconciler for every system
  // stack whose template declares a non-empty vault section. This keeps Vault
  // state in sync with the template files without requiring a full apply.
  if (BUNDLES_DRIVE_BUILTIN) {
    await runBuiltinVaultReconcile(prisma, templateByName, log);
  }

  // 4. Run one-time backfill migrations (e.g. EnvironmentNetwork → InfraResource).
  await runSystemStackMigrations(prisma);

  log.info({ bundlesDriveBuiltin: BUNDLES_DRIVE_BUILTIN }, "Built-in stack sync complete");
}

async function upgradeExistingStacksForTemplates(
  prisma: PrismaClient,
  templateByName: Map<string, { id: string; template: LoadedTemplate }>,
  log: ReturnType<typeof getLogger>
): Promise<void> {
  const builtinStacks = await prisma.stack.findMany({
    where: { builtinVersion: { not: null } },
    select: { id: true, name: true, environmentId: true },
  });

  for (const s of builtinStacks) {
    const entry = templateByName.get(s.name);
    if (!entry) continue;

    let networkType = "local";
    if (s.environmentId) {
      const env = await prisma.environment.findUnique({
        where: { id: s.environmentId },
        select: { networkType: true },
      });
      networkType = env?.networkType ?? "local";
    }

    try {
      await upgradeStackFromTemplate(prisma, entry.id, entry.template, s.id, log, networkType);
    } catch (error) {
      log.error(
        { error, stackName: s.name, environmentId: s.environmentId },
        "Failed to upgrade built-in stack from template"
      );
    }
  }
}

/**
 * Upgrade an existing Stack row if the template version on disk has advanced,
 * and apply environment-driven parameter overrides to non-running stacks.
 * Never creates a stack — creation is user-initiated via template instantiation.
 */
async function upgradeStackFromTemplate(
  prisma: PrismaClient,
  templateId: string,
  template: LoadedTemplate,
  stackId: string,
  log: ReturnType<typeof getLogger>,
  networkType: string = "local"
): Promise<void> {
  const { definition } = template;
  const networkTypeDefaults = definition.networkTypeDefaults ?? {};
  const parameterOverrides = networkTypeDefaults[networkType] ?? {};

  const existing = await prisma.stack.findUnique({ where: { id: stackId } });
  if (!existing || existing.builtinVersion === null) return;

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

  // DB version matches — no upgrade needed
  if (existing.builtinVersion >= template.builtinVersion) return;

  log.info(
    {
      stackName: template.name,
      oldVersion: existing.builtinVersion,
      newVersion: template.builtinVersion,
    },
    "Upgrading built-in stack to newer template version"
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
