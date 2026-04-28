import { PrismaClient, Prisma } from "../../generated/prisma/client";
import type {
  StackTemplateInfo,
  StackTemplateVersionInfo,
  StackTemplateServiceInfo,
  StackTemplateConfigFileInfo,
  StackTemplateConfigFileInput,
  CreateStackTemplateRequest,
  UpdateStackTemplateRequest,
  DraftVersionInput,
  PublishDraftRequest,
  CreateStackFromTemplateRequest,
  StackTemplateSource,
  StackTemplateScope,
  StackTemplateVersionStatus,
  StackServiceType,
  EnvironmentNetworkType,
} from "@mini-infra/types";
import type {
  StackServiceDefinition,
  StackParameterDefinition,
  StackParameterValue,
  StackInfo,
  StackDefinition,
} from "@mini-infra/types";
import { toServiceCreateInput, serializeStack, mergeParameterValues } from "./utils";
import { EgressPolicyLifecycleService } from "../egress/egress-policy-lifecycle";
import { CloudflareService } from "../cloudflare/cloudflare-service";
import { networkUtils } from "../network-utils";
import {
  parameterNamesFromDefinitions,
  validateTemplateSubstitutions,
} from "./template-substitution-validator";
import { encryptInputValues } from "./stack-input-values-service";

// Input shape for upserting system templates from builtin definitions
export interface UpsertSystemTemplateInput {
  name: string;
  displayName: string;
  scope: StackTemplateScope;
  networkType?: EnvironmentNetworkType | null;
  category?: string;
  builtinVersion: number;
  definition: StackDefinition;
  configFiles?: StackTemplateConfigFileInput[];
}

// Include helpers for Prisma queries.
// `as const` gives Prisma's GetPayload precise literal types so the generated
// payload shapes carry the right field sets at the TypeScript level.
const versionWithDetails = {
  services: { orderBy: { order: "asc" as const } },
  configFiles: true,
} as const;

const versionSummary = {
  id: true,
  templateId: true,
  version: true,
  status: true,
  notes: true,
  parameters: true,
  defaultParameterValues: true,
  networkTypeDefaults: true,
  resourceOutputs: true,
  resourceInputs: true,
  networks: true,
  volumes: true,
  inputs: true,
  vaultPolicies: true,
  vaultAppRoles: true,
  vaultKv: true,
  publishedAt: true,
  createdAt: true,
  createdById: true,
  _count: { select: { services: true } },
  services: { select: { serviceType: true }, orderBy: { order: 'asc' as const } },
} as const;

// The two version payload shapes Prisma can return. The detail shape (from
// `include: versionWithDetails`) carries full services and configFiles.
// The summary shape (from `select: versionSummary`) carries only a service
// count and per-service serviceType — enough for list views.
type VersionDetailPayload = Prisma.StackTemplateVersionGetPayload<{
  include: typeof versionWithDetails;
}>;

type VersionSummaryPayload = Prisma.StackTemplateVersionGetPayload<{
  select: typeof versionSummary;
}>;

type SerializableVersion = VersionDetailPayload | VersionSummaryPayload;

// Structural interface covering all the different template query shapes
// (list, detail, create, update). Relations are optional because different
// callers include different subsets.
interface SerializableTemplate {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: StackTemplateSource;
  scope: StackTemplateScope;
  networkType: string | null;
  category: string | null;
  environmentId: string | null;
  isArchived: boolean;
  currentVersionId: string | null;
  draftVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
  currentVersion?: SerializableVersion | null;
  draftVersion?: SerializableVersion | null;
  stacks?: Array<{
    id: string;
    name: string;
    status: string;
    version: number;
    lastAppliedVersion: number | null;
    lastAppliedAt: Date | null;
    environmentId: string | null;
  }>;
}

// Type guard: detail payload always has `configFiles`; summary payload never does.
function isVersionDetailPayload(v: SerializableVersion): v is VersionDetailPayload {
  return 'configFiles' in v;
}

export class StackTemplateService {
  constructor(private prisma: PrismaClient) {}

  // =====================
  // Query Methods
  // =====================

  async listTemplates(opts?: {
    source?: StackTemplateSource;
    scope?: StackTemplateScope;
    environmentId?: string;
    includeArchived?: boolean;
    includeLinkedStacks?: boolean;
  }): Promise<StackTemplateInfo[]> {
    const where: Prisma.StackTemplateWhereInput = {};
    if (opts?.source) where.source = opts.source;
    if (opts?.scope === "host") {
      where.scope = { in: ["host", "any"] };
    } else if (opts?.scope === "environment") {
      where.scope = { in: ["environment", "any"] };
    } else if (opts?.scope) {
      where.scope = opts.scope;
    }
    if (!opts?.includeArchived) where.isArchived = false;

    // When filtering by environment, hide templates whose networkType doesn't match.
    if (opts?.environmentId) {
      const env = await this.prisma.environment.findUnique({
        where: { id: opts.environmentId },
        select: { networkType: true },
      });
      if (env) {
        where.OR = [{ networkType: null }, { networkType: env.networkType }];
      }
    }

    const templates = await this.prisma.stackTemplate.findMany({
      where,
      include: {
        currentVersion: { select: versionSummary },
        draftVersion: { select: versionSummary },
        ...(opts?.includeLinkedStacks ? {
          stacks: {
            select: {
              id: true,
              name: true,
              status: true,
              version: true,
              lastAppliedVersion: true,
              lastAppliedAt: true,
              environmentId: true,
            },
          },
        } : {}),
      },
      orderBy: { name: "asc" },
    });

    return templates.map((t) => this.serializeTemplate(t));
  }

  async getTemplate(
    templateId: string,
    opts?: { includeVersions?: boolean }
  ): Promise<StackTemplateInfo | null> {
    const template = await this.prisma.stackTemplate.findUnique({
      where: { id: templateId },
      include: {
        currentVersion: {
          include: versionWithDetails,
        },
        draftVersion: {
          include: versionWithDetails,
        },
        ...(opts?.includeVersions
          ? {
              versions: {
                orderBy: { version: "desc" as const },
                select: versionSummary,
              },
            }
          : {}),
      },
    });

    if (!template) return null;
    return this.serializeTemplate(template);
  }

  async getTemplateVersion(
    versionId: string
  ): Promise<StackTemplateVersionInfo | null> {
    const version = await this.prisma.stackTemplateVersion.findUnique({
      where: { id: versionId },
      include: versionWithDetails,
    });

    if (!version) return null;
    return this.serializeVersion(version);
  }

  async getPublishedVersion(
    templateId: string
  ): Promise<StackTemplateVersionInfo | null> {
    const template = await this.prisma.stackTemplate.findUnique({
      where: { id: templateId },
      select: { currentVersionId: true },
    });

    if (!template?.currentVersionId) return null;
    return this.getTemplateVersion(template.currentVersionId);
  }

  async listVersions(templateId: string): Promise<StackTemplateVersionInfo[]> {
    const versions = await this.prisma.stackTemplateVersion.findMany({
      where: { templateId },
      include: versionWithDetails,
      orderBy: { version: "desc" },
    });

    return versions.map((v) => this.serializeVersion(v));
  }

  // =====================
  // User Template CRUD
  // =====================

  async createUserTemplate(
    input: CreateStackTemplateRequest,
    createdById?: string
  ): Promise<StackTemplateInfo> {
    // Check for name collision (allow re-use of archived templates)
    const existing = await this.prisma.stackTemplate.findUnique({
      where: { name_source: { name: input.name, source: "user" } },
    });
    if (existing && !existing.isArchived) {
      throw new TemplateError(
        `A user template named "${input.name}" already exists`,
        409
      );
    }

    // Extract config files from services (they come embedded in StackServiceDefinition.configFiles)
    // and also accept top-level configFiles input
    const configFileInputs = input.configFiles ?? [];

    const result = await this.prisma.$transaction(async (tx) => {
      // Re-use archived template if one exists, otherwise create new
      let template;
      if (existing?.isArchived) {
        template = await tx.stackTemplate.update({
          where: { id: existing.id },
          data: {
            displayName: input.displayName,
            description: input.description ?? null,
            scope: input.scope,
            networkType: input.networkType ?? null,
            category: input.category ?? null,
            environmentId: input.environmentId ?? null,
            isArchived: false,
            currentVersionId: null,
            draftVersionId: null,
          },
        });
      } else {
        template = await tx.stackTemplate.create({
          data: {
            name: input.name,
            displayName: input.displayName,
            description: input.description ?? null,
            source: "user",
            scope: input.scope,
            networkType: input.networkType ?? null,
            category: input.category ?? null,
            environmentId: input.environmentId ?? null,
            createdById: createdById ?? null,
          },
        });
      }

      // Create draft version (version 0)
      const version = await tx.stackTemplateVersion.create({
        data: {
          templateId: template.id,
          version: 0,
          status: "draft",
          parameters: (input.parameters ?? []) as unknown as Prisma.InputJsonValue,
          defaultParameterValues: (input.defaultParameterValues ?? {}) as unknown as Prisma.InputJsonValue,
          networkTypeDefaults: (input.networkTypeDefaults ?? {}) as unknown as Prisma.InputJsonValue,
          resourceOutputs: input.resourceOutputs ? (input.resourceOutputs as unknown as Prisma.InputJsonValue) : undefined,
          resourceInputs: input.resourceInputs ? (input.resourceInputs as unknown as Prisma.InputJsonValue) : undefined,
          networks: input.networks as unknown as Prisma.InputJsonValue,
          volumes: input.volumes as unknown as Prisma.InputJsonValue,
          createdById: createdById ?? null,
          services: {
            create: input.services.map((s, i) =>
              toTemplateServiceCreate(s, i)
            ),
          },
          configFiles: {
            create: configFileInputs.map(toTemplateConfigFileCreate),
          },
        },
      });

      // Set draftVersionId
      const updated = await tx.stackTemplate.update({
        where: { id: template.id },
        data: { draftVersionId: version.id },
        include: {
          draftVersion: { include: versionWithDetails },
        },
      });

      return updated;
    });

    return this.serializeTemplate(result);
  }

  async updateTemplateMeta(
    templateId: string,
    input: UpdateStackTemplateRequest
  ): Promise<StackTemplateInfo> {
    const template = await this.prisma.stackTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) {
      throw new TemplateError("Template not found", 404);
    }
    if (template.source === "system") {
      throw new TemplateError("Cannot modify system templates", 403);
    }

    const updated = await this.prisma.stackTemplate.update({
      where: { id: templateId },
      data: {
        displayName: input.displayName,
        description: input.description,
        category: input.category,
      },
      include: {
        currentVersion: { select: versionSummary },
        draftVersion: { select: versionSummary },
      },
    });

    return this.serializeTemplate(updated);
  }

  async deleteTemplate(templateId: string): Promise<void> {
    const template = await this.prisma.stackTemplate.findUnique({
      where: { id: templateId },
      include: { stacks: { select: { id: true, removedAt: true } } },
    });
    if (!template) {
      throw new TemplateError("Template not found", 404);
    }
    if (template.source === "system") {
      throw new TemplateError("Cannot delete system templates", 403);
    }

    await this.prisma.$transaction([
      // Delete all linked stacks (active and removed)
      this.prisma.stack.deleteMany({ where: { templateId } }),
      // Null out self-referential version FKs to break circular dependency
      this.prisma.stackTemplate.update({
        where: { id: templateId },
        data: { currentVersionId: null, draftVersionId: null },
      }),
      // Delete the template (cascade handles versions, services, config files)
      this.prisma.stackTemplate.delete({ where: { id: templateId } }),
    ]);
  }

  // =====================
  // Draft Lifecycle
  // =====================

  async createOrUpdateDraft(
    templateId: string,
    input: DraftVersionInput,
    createdById?: string
  ): Promise<StackTemplateVersionInfo> {
    const template = await this.prisma.stackTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) {
      throw new TemplateError("Template not found", 404);
    }
    if (template.source === "system") {
      throw new TemplateError("Cannot modify system templates", 403);
    }

    // Catch substitution typos (e.g. {{stak.id}}, {{environment.foo}}) at
    // draft-save time so the operator sees them immediately instead of
    // discovering them at apply when a real deploy is in flight.
    const inputNames = new Set((input.inputs ?? []).map((i) => i.name));
    const issues = validateTemplateSubstitutions({
      scope: template.scope,
      parameterNames: parameterNamesFromDefinitions(input.parameters),
      inputNames,
      services: input.services,
      configFiles: input.configFiles,
      networks: input.networks,
      volumes: input.volumes,
      resourceInputs: input.resourceInputs,
      resourceOutputs: input.resourceOutputs,
      vaultPolicies: input.vault?.policies,
      vaultAppRoles: input.vault?.appRoles,
      vaultKvPaths: (input.vault?.kv ?? []).map((k) => k.path),
    });
    if (issues.length > 0) {
      const summary = issues
        .slice(0, 5)
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ');
      const suffix = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
      throw new TemplateError(
        `Template substitution validation failed: ${summary}${suffix}`,
        400,
      );
    }

    const configFileInputs = input.configFiles ?? [];

    const result = await this.prisma.$transaction(async (tx) => {
      // Delete existing draft if any
      if (template.draftVersionId) {
        await tx.stackTemplateVersion.delete({
          where: { id: template.draftVersionId },
        });
      }

      // Create new draft version
      const version = await tx.stackTemplateVersion.create({
        data: {
          templateId,
          version: 0,
          status: "draft",
          notes: input.notes ?? null,
          parameters: (input.parameters ?? []) as unknown as Prisma.InputJsonValue,
          defaultParameterValues: (input.defaultParameterValues ?? {}) as unknown as Prisma.InputJsonValue,
          networkTypeDefaults: (input.networkTypeDefaults ?? {}) as unknown as Prisma.InputJsonValue,
          resourceOutputs: input.resourceOutputs ? (input.resourceOutputs as unknown as Prisma.InputJsonValue) : undefined,
          resourceInputs: input.resourceInputs ? (input.resourceInputs as unknown as Prisma.InputJsonValue) : undefined,
          networks: input.networks as unknown as Prisma.InputJsonValue,
          volumes: input.volumes as unknown as Prisma.InputJsonValue,
          inputs: input.inputs ? (input.inputs as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          vaultPolicies: input.vault?.policies ? (input.vault.policies as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          vaultAppRoles: input.vault?.appRoles ? (input.vault.appRoles as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          vaultKv: input.vault?.kv ? (input.vault.kv as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          createdById: createdById ?? null,
          services: {
            create: input.services.map((s, i) =>
              toTemplateServiceCreate(s, i)
            ),
          },
          configFiles: {
            create: configFileInputs.map(toTemplateConfigFileCreate),
          },
        },
        include: versionWithDetails,
      });

      // Update template pointer
      await tx.stackTemplate.update({
        where: { id: templateId },
        data: { draftVersionId: version.id },
      });

      return version;
    });

    return this.serializeVersion(result);
  }

  async publishDraft(
    templateId: string,
    input?: PublishDraftRequest
  ): Promise<StackTemplateVersionInfo> {
    const template = await this.prisma.stackTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) {
      throw new TemplateError("Template not found", 404);
    }
    if (template.source === "system") {
      throw new TemplateError("Cannot publish system templates via API", 403);
    }
    if (!template.draftVersionId) {
      throw new TemplateError(
        "No draft version exists for this template",
        404
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // A published template must have at least one service. The check lives
      // inside the transaction so a concurrent `createOrUpdateDraft` (which
      // deletes + recreates the draft version) can't race with publish and
      // let an empty draft slip through.
      const serviceCount = await tx.stackTemplateService.count({
        where: { versionId: template.draftVersionId! },
      });
      if (serviceCount < 1) {
        throw new TemplateError(
          "Cannot publish: the draft has no services defined",
          400
        );
      }

      // Find the highest published version number
      const maxVersion = await tx.stackTemplateVersion.findFirst({
        where: {
          templateId,
          status: { in: ["published", "archived"] },
        },
        orderBy: { version: "desc" },
        select: { version: true },
      });

      const nextVersion = (maxVersion?.version ?? 0) + 1;
      const now = new Date();

      // Promote draft to published
      const version = await tx.stackTemplateVersion.update({
        where: { id: template.draftVersionId! },
        data: {
          version: nextVersion,
          status: "published",
          publishedAt: now,
          notes: input?.notes ?? undefined,
        },
        include: versionWithDetails,
      });

      // Update template pointers
      await tx.stackTemplate.update({
        where: { id: templateId },
        data: {
          currentVersionId: version.id,
          draftVersionId: null,
        },
      });

      return version;
    });

    return this.serializeVersion(result);
  }

  async discardDraft(templateId: string): Promise<void> {
    const template = await this.prisma.stackTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) {
      throw new TemplateError("Template not found", 404);
    }
    if (template.source === "system") {
      throw new TemplateError("Cannot modify system templates", 403);
    }
    if (!template.draftVersionId) {
      throw new TemplateError(
        "No draft version exists for this template",
        404
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.stackTemplate.update({
        where: { id: templateId },
        data: { draftVersionId: null },
      });

      await tx.stackTemplateVersion.delete({
        where: { id: template.draftVersionId! },
      });
    });
  }

  // =====================
  // System Template Upsert
  // =====================

  async upsertSystemTemplate(
    input: UpsertSystemTemplateInput
  ): Promise<{ templateId: string; versionId: string; created: boolean }> {
    const {
      name,
      displayName,
      scope,
      networkType,
      category,
      builtinVersion,
      definition,
      configFiles: externalConfigFiles,
    } = input;

    const networkTypeDefaults = (definition as { networkTypeDefaults?: unknown }).networkTypeDefaults ?? {};

    // Check if template exists
    const existing = await this.prisma.stackTemplate.findUnique({
      where: { name_source: { name, source: "system" } },
      include: {
        currentVersion: { select: { id: true, version: true } },
      },
    });

    // If current version matches, no-op
    if (
      existing?.currentVersion &&
      existing.currentVersion.version >= builtinVersion
    ) {
      return {
        templateId: existing.id,
        versionId: existing.currentVersion.id,
        created: false,
      };
    }

    // Build config files from service definitions + external config files
    const configFileInputs = buildConfigFilesFromDefinition(
      definition,
      externalConfigFiles
    );

    const result = await this.prisma.$transaction(async (tx) => {
      // Upsert the template record
      const template = existing
        ? await tx.stackTemplate.update({
            where: { id: existing.id },
            data: {
              displayName,
              description: definition.description ?? null,
              scope,
              networkType: networkType ?? null,
              category: category ?? null,
            },
          })
        : await tx.stackTemplate.create({
            data: {
              name,
              displayName,
              description: definition.description ?? null,
              source: "system",
              scope,
              networkType: networkType ?? null,
              category: category ?? null,
            },
          });

      // Check if this version already exists (idempotent)
      const existingVersion =
        await tx.stackTemplateVersion.findUnique({
          where: {
            templateId_version: {
              templateId: template.id,
              version: builtinVersion,
            },
          },
        });

      let versionId: string;

      if (existingVersion) {
        // Update existing version's content
        versionId = existingVersion.id;

        // Delete and recreate services and config files
        await tx.stackTemplateService.deleteMany({
          where: { versionId },
        });
        await tx.stackTemplateConfigFile.deleteMany({
          where: { versionId },
        });

        await tx.stackTemplateVersion.update({
          where: { id: versionId },
          data: {
            parameters: (definition.parameters ?? []) as unknown as Prisma.InputJsonValue,
            defaultParameterValues: buildDefaultParameterValues(
              definition.parameters ?? []
            ) as unknown as Prisma.InputJsonValue,
            networkTypeDefaults: networkTypeDefaults as unknown as Prisma.InputJsonValue,
            resourceOutputs: definition.resourceOutputs ? (definition.resourceOutputs as unknown as Prisma.InputJsonValue) : undefined,
            resourceInputs: definition.resourceInputs ? (definition.resourceInputs as unknown as Prisma.InputJsonValue) : undefined,
            networks: definition.networks as unknown as Prisma.InputJsonValue,
            volumes: definition.volumes as unknown as Prisma.InputJsonValue,
            publishedAt: new Date(),
          },
        });
      } else {
        // Create new version
        const version = await tx.stackTemplateVersion.create({
          data: {
            templateId: template.id,
            version: builtinVersion,
            status: "published",
            parameters: (definition.parameters ?? []) as unknown as Prisma.InputJsonValue,
            defaultParameterValues: buildDefaultParameterValues(
              definition.parameters ?? []
            ) as unknown as Prisma.InputJsonValue,
            networkTypeDefaults: networkTypeDefaults as unknown as Prisma.InputJsonValue,
            resourceOutputs: definition.resourceOutputs ? (definition.resourceOutputs as unknown as Prisma.InputJsonValue) : undefined,
            resourceInputs: definition.resourceInputs ? (definition.resourceInputs as unknown as Prisma.InputJsonValue) : undefined,
            networks: definition.networks as unknown as Prisma.InputJsonValue,
            volumes: definition.volumes as unknown as Prisma.InputJsonValue,
            publishedAt: new Date(),
          },
        });
        versionId = version.id;
      }

      // Create services
      for (const svc of definition.services) {
        await tx.stackTemplateService.create({
          data: {
            versionId,
            ...toTemplateServiceCreate(svc, svc.order),
          },
        });
      }

      // Create config files
      for (const cf of configFileInputs) {
        await tx.stackTemplateConfigFile.create({
          data: {
            versionId,
            ...toTemplateConfigFileCreate(cf),
          },
        });
      }

      // Update template's currentVersionId
      await tx.stackTemplate.update({
        where: { id: template.id },
        data: { currentVersionId: versionId },
      });

      return { templateId: template.id, versionId };
    });

    return { ...result, created: !existing };
  }

  // =====================
  // Stack Creation from Template
  // =====================

  async createStackFromTemplate(
    input: CreateStackFromTemplateRequest,
    _createdById?: string
  ): Promise<StackInfo> {
    const template = await this.prisma.stackTemplate.findUnique({
      where: { id: input.templateId },
      include: {
        currentVersion: {
          include: versionWithDetails,
        },
      },
    });

    if (!template) {
      throw new TemplateError("Template not found", 404);
    }
    if (!template.currentVersion) {
      throw new TemplateError(
        "Template has no published version",
        400
      );
    }
    if (template.isArchived) {
      throw new TemplateError(
        "Cannot create stack from archived template",
        400
      );
    }

    const version = template.currentVersion;
    const paramDefs = version.parameters as unknown as StackParameterDefinition[];
    const defaultValues = version.defaultParameterValues as unknown as Record<
      string,
      StackParameterValue
    >;

    // Look up environment networkType if environment-scoped
    let networkDefaults: Record<string, StackParameterValue> = {};
    if (input.environmentId) {
      const env = await this.prisma.environment.findUnique({
        where: { id: input.environmentId },
        select: { networkType: true },
      });
      if (env) {
        if (template.networkType && template.networkType !== env.networkType) {
          const article = template.networkType === "internet" ? "an" : "a";
          throw new TemplateError(
            `Template "${template.name}" requires ${article} ${template.networkType} environment (target is ${env.networkType})`,
            400
          );
        }
        const ntDefaults = version.networkTypeDefaults as unknown as Record<string, Record<string, StackParameterValue>> | null;
        networkDefaults = ntDefaults?.[env.networkType] ?? {};
      }
    }

    // Merge: definition defaults → network-type defaults → user overrides
    const mergedValues = mergeParameterValues(
      paramDefs,
      { ...defaultValues, ...networkDefaults, ...(input.parameterValues ?? {}) }
    );

    // Build service definitions from template services + config files
    const services = buildServiceDefinitionsFromVersion(version);

    // Validate scope. For `any`-scoped templates the presence of environmentId
    // determines the effective scope — either direction is allowed.
    if (template.scope === "host" && input.environmentId) {
      throw new TemplateError(
        "Host-scoped template cannot be assigned to an environment",
        400
      );
    }
    if (template.scope === "environment" && !input.environmentId) {
      throw new TemplateError(
        "Environment-scoped template requires an environmentId",
        400
      );
    }

    const stackName = input.name ?? template.name;

    // Build stack-level resource arrays from service routing definitions
    const tunnelIngressDefs: { name: string; fqdn: string; service: string }[] = [];
    const tlsCertDefs: { name: string; fqdn: string }[] = [];
    const dnsRecordDefs: { name: string; fqdn: string; recordType: "A"; target: string }[] = [];

    if (input.environmentId) {
      // --- Tunnel Ingress (internet-facing environments) ---
      const hasTunnelServices = services.some((svc) => {
        const routing = svc.routing as { tunnelIngress?: string; tlsCertificate?: string; dnsRecord?: string } | null;
        return !!routing?.tunnelIngress;
      });

      if (hasTunnelServices) {
        // Try to resolve tunnel config, auto-resolving if not set on environment
        const envForTunnel = await this.prisma.environment.findUnique({
          where: { id: input.environmentId },
          select: { tunnelServiceUrl: true, tunnelId: true, name: true },
        });

        let tunnelServiceUrl: string | null = envForTunnel?.tunnelServiceUrl ?? null;

        // Auto-resolve tunnelServiceUrl from HAProxy stack if not configured
        if (!tunnelServiceUrl) {
          const haproxyStack = await this.prisma.stack.findFirst({
            where: {
              name: "haproxy",
              environmentId: input.environmentId,
              status: { not: "removed" },
            },
            include: {
              services: { where: { serviceName: "haproxy" }, take: 1 },
              environment: { select: { name: true } },
            },
          });

          if (haproxyStack?.environment) {
            tunnelServiceUrl = `http://${haproxyStack.environment.name}-haproxy-haproxy:80`;

            // Persist for future use and for the reconciler
            await this.prisma.environment.update({
              where: { id: input.environmentId },
              data: { tunnelServiceUrl },
            });
          }
        }

        // Auto-resolve tunnelId from managed tunnel info if not configured
        if (!envForTunnel?.tunnelId) {
          const cloudflareConfig = new CloudflareService(this.prisma);
          const managedTunnel = await cloudflareConfig.getManagedTunnelInfo(input.environmentId);
          if (managedTunnel?.tunnelId) {
            await this.prisma.environment.update({
              where: { id: input.environmentId },
              data: { tunnelId: managedTunnel.tunnelId },
            });
          }
        }

        if (!tunnelServiceUrl) {
          throw new TemplateError(
            "Could not resolve tunnel service URL. Ensure the environment has an HAProxy stack deployed or configure the tunnel service URL in the environment settings.",
            400,
          );
        }

        for (const svc of services) {
          const routing = svc.routing as { tunnelIngress?: string; tlsCertificate?: string; dnsRecord?: string } | null;
          if (routing?.tunnelIngress && !tunnelIngressDefs.some((d) => d.name === routing.tunnelIngress)) {
            tunnelIngressDefs.push({
              name: routing.tunnelIngress,
              fqdn: routing.tunnelIngress,
              service: tunnelServiceUrl,
            });
          }
        }
      }

      // --- TLS Certificates (local environments) ---
      for (const svc of services) {
        const routing = svc.routing as { tunnelIngress?: string; tlsCertificate?: string; dnsRecord?: string } | null;
        if (routing?.tlsCertificate && !tlsCertDefs.some((d) => d.name === routing.tlsCertificate)) {
          tlsCertDefs.push({
            name: routing.tlsCertificate,
            fqdn: routing.tlsCertificate,
          });
        }
      }

      // --- DNS Records (local environments) ---
      const hasDnsServices = services.some((svc) => {
        const routing = svc.routing as { tunnelIngress?: string; tlsCertificate?: string; dnsRecord?: string } | null;
        return !!routing?.dnsRecord;
      });

      if (hasDnsServices) {
        const targetIp = await networkUtils.getAppropriateIPForEnvironment(input.environmentId);
        for (const svc of services) {
          const routing = svc.routing as { tunnelIngress?: string; tlsCertificate?: string; dnsRecord?: string } | null;
          if (routing?.dnsRecord && !dnsRecordDefs.some((d) => d.name === routing.dnsRecord)) {
            dnsRecordDefs.push({
              name: routing.dnsRecord,
              fqdn: routing.dnsRecord,
              recordType: "A",
              target: targetIp,
            });
          }
        }
      }
    }

    const encryptedInputValues =
      input.inputValues && Object.keys(input.inputValues).length > 0
        ? encryptInputValues(input.inputValues)
        : null;

    const stack = await this.prisma.stack.create({
      data: {
        name: stackName,
        description: template.description,
        environmentId: input.environmentId ?? null,
        version: 1,
        status: "undeployed",
        templateId: template.id,
        templateVersion: version.version,
        builtinVersion:
          template.source === "system" ? version.version : null,
        parameters:
          paramDefs.length > 0 ? (paramDefs as unknown as Prisma.InputJsonValue) : undefined,
        parameterValues:
          Object.keys(mergedValues).length > 0
            ? (mergedValues as unknown as Prisma.InputJsonValue)
            : undefined,
        resourceOutputs: version.resourceOutputs ? (version.resourceOutputs as unknown as Prisma.InputJsonValue) : undefined,
        resourceInputs: version.resourceInputs ? (version.resourceInputs as unknown as Prisma.InputJsonValue) : undefined,
        networks: version.networks as unknown as Prisma.InputJsonValue,
        volumes: version.volumes as unknown as Prisma.InputJsonValue,
        tunnelIngress: tunnelIngressDefs.length > 0 ? tunnelIngressDefs : undefined,
        tlsCertificates: tlsCertDefs.length > 0 ? tlsCertDefs : undefined,
        dnsRecords: dnsRecordDefs.length > 0 ? dnsRecordDefs : undefined,
        encryptedInputValues,
        services: {
          create: services.map(toServiceCreateInput),
        },
      },
      include: {
        services: { orderBy: { order: "asc" } },
      },
    });

    // Ensure a default egress policy exists for env-scoped stacks, then
    // reconcile any template-declared requiredEgress rules.
    const egressLifecycle = new EgressPolicyLifecycleService(this.prisma);
    await egressLifecycle.ensureDefaultPolicy(stack.id, _createdById ?? null);
    await egressLifecycle.reconcileTemplateRules(stack.id, _createdById ?? null);

    return serializeStack(stack);
  }

  // =====================
  // Serialization
  // =====================

  serializeTemplate(template: SerializableTemplate): StackTemplateInfo {
    return {
      id: template.id,
      name: template.name,
      displayName: template.displayName,
      description: template.description,
      source: template.source,
      scope: template.scope,
      networkType: (template.networkType as EnvironmentNetworkType | null) ?? null,
      category: template.category,
      environmentId: template.environmentId ?? null,
      isArchived: template.isArchived,
      currentVersionId: template.currentVersionId,
      draftVersionId: template.draftVersionId,
      createdAt: template.createdAt.toISOString(),
      updatedAt: template.updatedAt.toISOString(),
      createdById: template.createdById,
      currentVersion: template.currentVersion
        ? this.serializeVersion(template.currentVersion)
        : template.currentVersion === null
          ? null
          : undefined,
      draftVersion: template.draftVersion
        ? this.serializeVersion(template.draftVersion)
        : template.draftVersion === null
          ? null
          : undefined,
      ...(template.stacks ? {
        linkedStacks: template.stacks.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          version: s.version,
          lastAppliedVersion: s.lastAppliedVersion,
          lastAppliedAt: s.lastAppliedAt?.toISOString() ?? null,
          environmentId: s.environmentId,
        })),
      } : {}),
    };
  }

  serializeVersion(version: SerializableVersion): StackTemplateVersionInfo {
    // Fields common to both detail and summary payload shapes.
    // JSON columns (parameters, networks, etc.) come back from Prisma as
    // JsonValue and need a double-assertion to reach the domain types.
    const versionRecord = version as unknown as Record<string, unknown>;
    const vaultSection = buildVaultSection(versionRecord);
    const base: StackTemplateVersionInfo = {
      id: version.id,
      templateId: version.templateId,
      version: version.version,
      status: version.status as StackTemplateVersionStatus,
      notes: version.notes,
      parameters: (version.parameters as unknown as StackTemplateVersionInfo['parameters']) ?? [],
      defaultParameterValues: (version.defaultParameterValues as unknown as StackTemplateVersionInfo['defaultParameterValues']) ?? {},
      networkTypeDefaults: (version.networkTypeDefaults as unknown as StackTemplateVersionInfo['networkTypeDefaults']) ?? undefined,
      resourceOutputs: (version.resourceOutputs as unknown as StackTemplateVersionInfo['resourceOutputs']) ?? undefined,
      resourceInputs: (version.resourceInputs as unknown as StackTemplateVersionInfo['resourceInputs']) ?? undefined,
      networks: (version.networks as unknown as StackTemplateVersionInfo['networks']) ?? [],
      volumes: (version.volumes as unknown as StackTemplateVersionInfo['volumes']) ?? [],
      publishedAt: version.publishedAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString(),
      createdById: version.createdById,
      inputs: (versionRecord['inputs'] as unknown as StackTemplateVersionInfo['inputs']) ?? undefined,
      vault: vaultSection,
    };

    if (isVersionDetailPayload(version)) {
      // Detail shape: full services array + config files.
      return {
        ...base,
        serviceCount: version.services.length,
        serviceTypes: version.services.map((svc) => svc.serviceType as StackServiceType),
        services: version.services.map(serializeTemplateService),
        configFiles: version.configFiles.map(serializeTemplateConfigFile),
      };
    }

    // Summary shape: service count from _count, service types only (no full service objects).
    return {
      ...base,
      serviceCount: version._count.services,
      serviceTypes: version.services.map((svc) => svc.serviceType as StackServiceType),
    };
  }
}

// =====================
// Error class
// =====================

export class TemplateError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

// =====================
// Helpers
// =====================

function serializeTemplateService(svc: Prisma.StackTemplateServiceGetPayload<true>): StackTemplateServiceInfo {
  return {
    id: svc.id,
    versionId: svc.versionId,
    serviceName: svc.serviceName,
    serviceType: svc.serviceType,
    dockerImage: svc.dockerImage,
    dockerTag: svc.dockerTag,
    containerConfig: svc.containerConfig as unknown as StackTemplateServiceInfo['containerConfig'],
    initCommands: svc.initCommands as unknown as StackTemplateServiceInfo['initCommands'],
    dependsOn: svc.dependsOn as unknown as StackTemplateServiceInfo['dependsOn'],
    order: svc.order,
    routing: svc.routing as unknown as StackTemplateServiceInfo['routing'],
    adoptedContainer: (svc.adoptedContainer ?? undefined) as unknown as StackTemplateServiceInfo['adoptedContainer'],
    poolConfig: (svc.poolConfig ?? null) as unknown as StackTemplateServiceInfo['poolConfig'],
    vaultAppRoleId: svc.vaultAppRoleId ?? null,
    vaultAppRoleRef: svc.vaultAppRoleRef ?? null,
  };
}

function serializeTemplateConfigFile(cf: Prisma.StackTemplateConfigFileGetPayload<true>): StackTemplateConfigFileInfo {
  return {
    id: cf.id,
    versionId: cf.versionId,
    serviceName: cf.serviceName,
    fileName: cf.fileName,
    volumeName: cf.volumeName,
    mountPath: cf.mountPath,
    content: cf.content,
    permissions: cf.permissions,
    owner: cf.owner,
  };
}

/**
 * Convert a StackServiceDefinition to a Prisma create input for StackTemplateService.
 */
function toTemplateServiceCreate(
  s: StackServiceDefinition & { vaultAppRoleRef?: string },
  fallbackOrder: number
) {
  return {
    serviceName: s.serviceName,
    serviceType: s.serviceType,
    dockerImage: s.dockerImage,
    dockerTag: s.dockerTag,
    containerConfig: s.containerConfig as unknown as Prisma.InputJsonValue,
    initCommands: (s.initCommands ?? null) as unknown as Prisma.InputJsonValue,
    dependsOn: s.dependsOn as unknown as Prisma.InputJsonValue,
    order: s.order ?? fallbackOrder,
    routing: s.routing ? (s.routing as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    adoptedContainer: s.adoptedContainer ? (s.adoptedContainer as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    poolConfig: s.poolConfig ? (s.poolConfig as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    vaultAppRoleId: s.vaultAppRoleId ?? null,
    vaultAppRoleRef: s.vaultAppRoleRef ?? null,
  };
}

/**
 * Build the vault section for a serialized version from its stored JSON columns.
 * Returns undefined if no vault columns are set.
 */
function buildVaultSection(version: Record<string, unknown>): StackTemplateVersionInfo['vault'] {
  if (!version['vaultPolicies'] && !version['vaultAppRoles'] && !version['vaultKv']) return undefined;
  type VaultSection = NonNullable<StackTemplateVersionInfo['vault']>;
  return {
    policies: (version['vaultPolicies'] as unknown as VaultSection['policies']) ?? undefined,
    appRoles: (version['vaultAppRoles'] as unknown as VaultSection['appRoles']) ?? undefined,
    kv: (version['vaultKv'] as unknown as VaultSection['kv']) ?? undefined,
  };
}


/**
 * Convert a config file input to a Prisma create shape for StackTemplateConfigFile.
 */
function toTemplateConfigFileCreate(cf: StackTemplateConfigFileInput) {
  return {
    serviceName: cf.serviceName,
    fileName: cf.fileName,
    volumeName: cf.volumeName,
    mountPath: cf.mountPath,
    content: cf.content,
    permissions: cf.permissions ?? null,
    owner: cf.owner ?? null,
  };
}

/**
 * Build default parameter values from parameter definitions.
 */
function buildDefaultParameterValues(
  params: StackParameterDefinition[]
): Record<string, StackParameterValue> {
  const values: Record<string, StackParameterValue> = {};
  for (const p of params) {
    values[p.name] = p.default;
  }
  return values;
}

/**
 * Extract config files from a StackDefinition's services and merge with external config files.
 * Normalizes the StackConfigFile shape (path → mountPath, derived fileName).
 */
function buildConfigFilesFromDefinition(
  definition: StackDefinition,
  externalConfigFiles?: StackTemplateConfigFileInput[]
): StackTemplateConfigFileInput[] {
  const result: StackTemplateConfigFileInput[] = [];

  // Extract from service configFiles
  for (const svc of definition.services) {
    if (svc.configFiles) {
      for (const cf of svc.configFiles) {
        result.push({
          serviceName: svc.serviceName,
          fileName: cf.path.split("/").pop() ?? cf.path,
          volumeName: cf.volumeName,
          mountPath: cf.path,
          content: cf.content,
          permissions: cf.permissions ?? undefined,
          owner:
            cf.ownerUid != null
              ? `${cf.ownerUid}:${cf.ownerGid ?? cf.ownerUid}`
              : undefined,
        });
      }
    }
  }

  // Merge external config files (overrides service-embedded ones on conflict)
  if (externalConfigFiles) {
    for (const cf of externalConfigFiles) {
      // Remove any existing entry with same key
      const idx = result.findIndex(
        (r) =>
          r.serviceName === cf.serviceName &&
          r.volumeName === cf.volumeName &&
          r.mountPath === cf.mountPath
      );
      if (idx >= 0) result.splice(idx, 1);
      result.push(cf);
    }
  }

  return result;
}

/**
 * Build StackServiceDefinition[] from a template version's services and config files.
 * Merges config files back into each service's configFiles array.
 */
function buildServiceDefinitionsFromVersion(version: {
  services?: Prisma.StackTemplateServiceGetPayload<true>[];
  configFiles?: Prisma.StackTemplateConfigFileGetPayload<true>[];
}): StackServiceDefinition[] {
  const services = version.services ?? [];
  const configFiles = version.configFiles ?? [];

  // Group config files by serviceName
  const cfByService = new Map<string, Prisma.StackTemplateConfigFileGetPayload<true>[]>();
  for (const cf of configFiles) {
    const list = cfByService.get(cf.serviceName) ?? [];
    list.push(cf);
    cfByService.set(cf.serviceName, list);
  }

  return services.map((svc): StackServiceDefinition => {
    const svcConfigFiles = cfByService.get(svc.serviceName) ?? [];
    return {
      serviceName: svc.serviceName,
      serviceType: svc.serviceType,
      dockerImage: svc.dockerImage,
      dockerTag: svc.dockerTag,
      containerConfig: svc.containerConfig as unknown as StackServiceDefinition['containerConfig'],
      configFiles: svcConfigFiles.length > 0
        ? svcConfigFiles.map((cf) => ({
            volumeName: cf.volumeName,
            path: cf.mountPath,
            content: cf.content,
            permissions: cf.permissions ?? undefined,
            ownerUid: cf.owner ? parseOwnerUid(cf.owner) : undefined,
            ownerGid: cf.owner ? parseOwnerGid(cf.owner) : undefined,
          }))
        : undefined,
      initCommands: (svc.initCommands as unknown as StackServiceDefinition['initCommands']) ?? undefined,
      dependsOn: (svc.dependsOn as unknown as string[] | null) ?? [],
      order: svc.order,
      routing: (svc.routing as unknown as StackServiceDefinition['routing']) ?? undefined,
      adoptedContainer: (svc.adoptedContainer as unknown as StackServiceDefinition['adoptedContainer']) ?? undefined,
      poolConfig: (svc.poolConfig as unknown as StackServiceDefinition['poolConfig']) ?? undefined,
      vaultAppRoleId: svc.vaultAppRoleId ?? undefined,
    };
  });
}

function parseOwnerUid(owner: string): number | undefined {
  const parts = owner.split(":");
  const uid = parseInt(parts[0], 10);
  return isNaN(uid) ? undefined : uid;
}

function parseOwnerGid(owner: string): number | undefined {
  const parts = owner.split(":");
  const gid = parseInt(parts[1] ?? parts[0], 10);
  return isNaN(gid) ? undefined : gid;
}
