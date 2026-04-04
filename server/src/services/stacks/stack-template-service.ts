import { PrismaClient, Prisma } from "@prisma/client";
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
} from "@mini-infra/types";
import type {
  StackServiceDefinition,
  StackParameterDefinition,
  StackParameterValue,
  StackInfo,
  StackDefinition,
} from "@mini-infra/types";
import { toServiceCreateInput, serializeStack, mergeParameterValues } from "./utils";
import { CloudflareService } from "../cloudflare/cloudflare-service";
import { networkUtils } from "../network-utils";

// Input shape for upserting system templates from builtin definitions
export interface UpsertSystemTemplateInput {
  name: string;
  displayName: string;
  scope: StackTemplateScope;
  category?: string;
  builtinVersion: number;
  definition: StackDefinition;
  configFiles?: StackTemplateConfigFileInput[];
}

// Include helpers for Prisma queries
const versionWithDetails = {
  services: { orderBy: { order: "asc" as const } },
  configFiles: true,
};

const versionSummary = {
  id: true,
  templateId: true,
  version: true,
  status: true,
  notes: true,
  parameters: true,
  defaultParameterValues: true,
  networks: true,
  volumes: true,
  publishedAt: true,
  createdAt: true,
  createdById: true,
  _count: { select: { services: true } },
};

export class StackTemplateService {
  constructor(private prisma: PrismaClient) {}

  // =====================
  // Query Methods
  // =====================

  async listTemplates(opts?: {
    source?: StackTemplateSource;
    scope?: StackTemplateScope;
    includeArchived?: boolean;
  }): Promise<StackTemplateInfo[]> {
    const where: any = {};
    if (opts?.source) where.source = opts.source;
    if (opts?.scope) where.scope = opts.scope;
    if (!opts?.includeArchived) where.isArchived = false;

    const templates = await this.prisma.stackTemplate.findMany({
      where,
      include: {
        currentVersion: { select: versionSummary },
        draftVersion: { select: versionSummary },
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
          parameters: (input.parameters ?? []) as any,
          defaultParameterValues: (input.defaultParameterValues ?? {}) as any,
          networkTypeDefaults: (input.networkTypeDefaults ?? {}) as any,
          resourceOutputs: input.resourceOutputs ? (input.resourceOutputs as any) : undefined,
          resourceInputs: input.resourceInputs ? (input.resourceInputs as any) : undefined,
          networks: input.networks as any,
          volumes: input.volumes as any,
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
          parameters: (input.parameters ?? []) as any,
          defaultParameterValues: (input.defaultParameterValues ?? {}) as any,
          networkTypeDefaults: (input.networkTypeDefaults ?? {}) as any,
          resourceOutputs: input.resourceOutputs ? (input.resourceOutputs as any) : undefined,
          resourceInputs: input.resourceInputs ? (input.resourceInputs as any) : undefined,
          networks: input.networks as any,
          volumes: input.volumes as any,
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
      category,
      builtinVersion,
      definition,
      configFiles: externalConfigFiles,
    } = input;

    const networkTypeDefaults = (definition as any).networkTypeDefaults ?? {};

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
            parameters: (definition.parameters ?? []) as any,
            defaultParameterValues: buildDefaultParameterValues(
              definition.parameters ?? []
            ) as any,
            networkTypeDefaults: networkTypeDefaults as any,
            resourceOutputs: definition.resourceOutputs ? (definition.resourceOutputs as any) : undefined,
            resourceInputs: definition.resourceInputs ? (definition.resourceInputs as any) : undefined,
            networks: definition.networks as any,
            volumes: definition.volumes as any,
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
            parameters: (definition.parameters ?? []) as any,
            defaultParameterValues: buildDefaultParameterValues(
              definition.parameters ?? []
            ) as any,
            networkTypeDefaults: networkTypeDefaults as any,
            resourceOutputs: definition.resourceOutputs ? (definition.resourceOutputs as any) : undefined,
            resourceInputs: definition.resourceInputs ? (definition.resourceInputs as any) : undefined,
            networks: definition.networks as any,
            volumes: definition.volumes as any,
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
  // Import from DeploymentConfiguration
  // =====================

  async importDeploymentConfig(
    configId: string,
    createdById?: string
  ): Promise<StackTemplateInfo> {
    // Look up the DeploymentConfiguration
    const config = await this.prisma.deploymentConfiguration.findUnique({
      where: { id: configId },
    });

    if (!config) {
      throw new TemplateError("Deployment configuration not found", 404);
    }

    const containerConfig = config.containerConfig as any;
    const healthCheckConfig = config.healthCheckConfig as any;
    const rollbackConfig = config.rollbackConfig as any;

    // Determine service type: StatelessWeb if hostname + listeningPort, else Stateful
    const hasRouting = !!(config.hostname && config.listeningPort);
    const serviceType = hasRouting ? "StatelessWeb" : "Stateful";

    // Map environment array → env object
    const env: Record<string, string> = {};
    if (Array.isArray(containerConfig?.environment)) {
      for (const e of containerConfig.environment) {
        if (e.name && e.value !== undefined) {
          env[e.name] = String(e.value);
        }
      }
    }

    // Map ports
    const ports = Array.isArray(containerConfig?.ports)
      ? containerConfig.ports.map((p: any) => ({
          containerPort: p.containerPort,
          hostPort: p.hostPort ?? p.containerPort,
          protocol: p.protocol ?? "tcp",
        }))
      : [];

    // Map volumes → mounts (bind type)
    const mounts = Array.isArray(containerConfig?.volumes)
      ? containerConfig.volumes.map((v: any) => ({
          source: v.hostPath,
          target: v.containerPath,
          type: "bind" as const,
          readOnly: v.mode === "ro",
        }))
      : [];

    // Map labels
    const labels = containerConfig?.labels ?? {};

    // Map networks → joinNetworks
    const joinNetworks = Array.isArray(containerConfig?.networks)
      ? containerConfig.networks
      : [];

    // Build healthcheck in Docker format
    let healthcheck: any = undefined;
    if (healthCheckConfig?.endpoint) {
      const method = healthCheckConfig.method ?? "GET";
      const endpoint = healthCheckConfig.endpoint;
      const port = config.listeningPort ?? 80;
      healthcheck = {
        test: [
          "CMD-SHELL",
          `curl -f -X ${method} http://localhost:${port}${endpoint} || exit 1`,
        ],
        interval: (healthCheckConfig.interval ?? 30000) * 1000000, // ms → ns
        timeout: (healthCheckConfig.timeout ?? 5000) * 1000000,
        retries: healthCheckConfig.retries ?? 3,
        startPeriod: 10000000000, // 10s default in ns
      };
    }

    // Build container config
    const stackContainerConfig: any = {
      env,
      ports,
      mounts,
      labels,
      joinNetworks,
      restartPolicy: "unless-stopped",
    };
    if (healthcheck) {
      stackContainerConfig.healthcheck = healthcheck;
    }

    // Build routing config for StatelessWeb
    let routing: any = undefined;
    if (hasRouting) {
      routing = {
        hostname: config.hostname!,
        listeningPort: config.listeningPort!,
        enableSsl: config.enableSsl ?? false,
        tlsCertificateId: config.tlsCertificateId ?? undefined,
      };
    }

    // Build docker image with registry prefix
    const dockerImage = config.dockerRegistry
      ? `${config.dockerRegistry}/${config.dockerImage}`
      : config.dockerImage;

    // Build default parameter values from rollback config and environment
    const defaultParameterValues: Record<string, any> = {};
    if (rollbackConfig) {
      if (rollbackConfig.enabled !== undefined) {
        defaultParameterValues.rollbackEnabled = rollbackConfig.enabled;
      }
      if (rollbackConfig.maxWaitTime !== undefined) {
        defaultParameterValues.rollbackMaxWaitTime = rollbackConfig.maxWaitTime;
      }
      if (rollbackConfig.keepOldContainer !== undefined) {
        defaultParameterValues.rollbackKeepOldContainer = rollbackConfig.keepOldContainer;
      }
    }
    // Build the service definition
    const service: StackServiceDefinition = {
      serviceName: config.applicationName,
      serviceType,
      dockerImage,
      dockerTag: config.dockerTag ?? 'latest',
      containerConfig: stackContainerConfig,
      dependsOn: [],
      order: 0,
      routing,
    };

    // Create the template via createUserTemplate
    const template = await this.createUserTemplate(
      {
        name: config.applicationName,
        displayName: config.applicationName,
        scope: "environment",
        environmentId: config.environmentId,
        services: [service],
        networks: [],
        volumes: [],
        defaultParameterValues,
      },
      createdById
    );

    // Publish the draft immediately
    await this.publishDraft(template.id, {
      notes: `Imported from deployment configuration: ${config.applicationName}`,
    });

    // Return the full template with the published version
    return (await this.getTemplate(template.id))!;
  }

  // =====================
  // Stack Creation from Template
  // =====================

  async createStackFromTemplate(
    input: CreateStackFromTemplateRequest,
    createdById?: string
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

    // Validate scope
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
        const routing = svc.routing as any;
        return !!routing?.tunnelIngress;
      });

      if (hasTunnelServices) {
        // Try to resolve tunnel config, auto-resolving if not set on environment
        let tunnelServiceUrl: string | null = null;

        const envForTunnel = await this.prisma.environment.findUnique({
          where: { id: input.environmentId },
          select: { tunnelServiceUrl: true, tunnelId: true, name: true },
        });

        tunnelServiceUrl = envForTunnel?.tunnelServiceUrl ?? null;

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
          const routing = svc.routing as any;
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
        const routing = svc.routing as any;
        if (routing?.tlsCertificate && !tlsCertDefs.some((d) => d.name === routing.tlsCertificate)) {
          tlsCertDefs.push({
            name: routing.tlsCertificate,
            fqdn: routing.tlsCertificate,
          });
        }
      }

      // --- DNS Records (local environments) ---
      const hasDnsServices = services.some((svc) => {
        const routing = svc.routing as any;
        return !!routing?.dnsRecord;
      });

      if (hasDnsServices) {
        const targetIp = await networkUtils.getAppropriateIPForEnvironment(input.environmentId);
        for (const svc of services) {
          const routing = svc.routing as any;
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
          paramDefs.length > 0 ? (paramDefs as any) : undefined,
        parameterValues:
          Object.keys(mergedValues).length > 0
            ? (mergedValues as any)
            : undefined,
        resourceOutputs: version.resourceOutputs ? (version.resourceOutputs as any) : undefined,
        resourceInputs: version.resourceInputs ? (version.resourceInputs as any) : undefined,
        networks: version.networks as any,
        volumes: version.volumes as any,
        tunnelIngress: tunnelIngressDefs.length > 0 ? tunnelIngressDefs : undefined,
        tlsCertificates: tlsCertDefs.length > 0 ? tlsCertDefs : undefined,
        dnsRecords: dnsRecordDefs.length > 0 ? dnsRecordDefs : undefined,
        services: {
          create: services.map(toServiceCreateInput),
        },
      },
      include: {
        services: { orderBy: { order: "asc" } },
      },
    });

    return serializeStack(stack);
  }

  // =====================
  // Serialization
  // =====================

  serializeTemplate(template: any): StackTemplateInfo {
    return {
      id: template.id,
      name: template.name,
      displayName: template.displayName,
      description: template.description,
      source: template.source,
      scope: template.scope,
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
    };
  }

  serializeVersion(version: any): StackTemplateVersionInfo {
    return {
      id: version.id,
      templateId: version.templateId,
      version: version.version,
      status: version.status,
      notes: version.notes,
      parameters: version.parameters ?? [],
      defaultParameterValues: version.defaultParameterValues ?? {},
      resourceOutputs: version.resourceOutputs ?? undefined,
      resourceInputs: version.resourceInputs ?? undefined,
      networks: version.networks ?? [],
      volumes: version.volumes ?? [],
      publishedAt: version.publishedAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString(),
      createdById: version.createdById,
      serviceCount: version._count?.services ?? version.services?.length,
      services: version.services?.map(serializeTemplateService),
      configFiles: version.configFiles?.map(serializeTemplateConfigFile),
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

function serializeTemplateService(svc: any): StackTemplateServiceInfo {
  return {
    id: svc.id,
    versionId: svc.versionId,
    serviceName: svc.serviceName,
    serviceType: svc.serviceType,
    dockerImage: svc.dockerImage,
    dockerTag: svc.dockerTag,
    containerConfig: svc.containerConfig,
    initCommands: svc.initCommands,
    dependsOn: svc.dependsOn,
    order: svc.order,
    routing: svc.routing,
  };
}

function serializeTemplateConfigFile(cf: any): StackTemplateConfigFileInfo {
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
  s: StackServiceDefinition,
  fallbackOrder: number
) {
  return {
    serviceName: s.serviceName,
    serviceType: s.serviceType,
    dockerImage: s.dockerImage,
    dockerTag: s.dockerTag,
    containerConfig: s.containerConfig as any,
    initCommands: (s.initCommands ?? null) as any,
    dependsOn: s.dependsOn as any,
    order: s.order ?? fallbackOrder,
    routing: s.routing ? (s.routing as any) : Prisma.DbNull,
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
  services?: any[];
  configFiles?: any[];
}): StackServiceDefinition[] {
  const services = version.services ?? [];
  const configFiles = version.configFiles ?? [];

  // Group config files by serviceName
  const cfByService = new Map<string, any[]>();
  for (const cf of configFiles) {
    const list = cfByService.get(cf.serviceName) ?? [];
    list.push(cf);
    cfByService.set(cf.serviceName, list);
  }

  return services.map((svc: any) => {
    const svcConfigFiles = cfByService.get(svc.serviceName) ?? [];
    return {
      serviceName: svc.serviceName,
      serviceType: svc.serviceType,
      dockerImage: svc.dockerImage,
      dockerTag: svc.dockerTag,
      containerConfig: svc.containerConfig,
      configFiles: svcConfigFiles.length > 0
        ? svcConfigFiles.map((cf: any) => ({
            volumeName: cf.volumeName,
            path: cf.mountPath,
            content: cf.content,
            permissions: cf.permissions ?? undefined,
            ownerUid: cf.owner ? parseOwnerUid(cf.owner) : undefined,
            ownerGid: cf.owner ? parseOwnerGid(cf.owner) : undefined,
          }))
        : undefined,
      initCommands: svc.initCommands ?? undefined,
      dependsOn: svc.dependsOn ?? [],
      order: svc.order,
      routing: svc.routing ?? undefined,
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
