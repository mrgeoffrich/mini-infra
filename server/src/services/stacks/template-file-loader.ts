import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import {
  stackParameterDefinitionSchema,
  stackContainerConfigSchema,
  stackInitCommandSchema,
  stackServiceRoutingSchema,
  stackNetworkSchema,
  stackVolumeSchema,
  stackResourceOutputSchema,
  stackResourceInputSchema,
  stackServiceCommonFieldsSchema,
  refineAddonsBlock,
} from "./schemas";
import { productionAddonRegistry } from "../stack-addons/registry";
import {
  templateInputDeclSchema,
  templateVaultPolicySchema,
  templateVaultAppRoleSchema,
  templateVaultKvSchema,
  templateNatsAccountSchema,
  templateNatsCredentialSchema,
  templateNatsStreamSchema,
  templateNatsConsumerSchema,
  templateNatsRoleSchema,
  templateNatsSignerSchema,
  templateNatsImportSchema,
  templateNatsSubjectPrefixSchema,
  natsRelativeSubjectSchema,
  validateNatsSectionShape,
} from "./stack-template-schemas";
import type { StackTemplateConfigFileInput } from "@mini-infra/types";
import { STACK_SERVICE_TYPES } from "@mini-infra/types";

// =====================
// Template File Schema
// =====================

const nameRegex = /^[a-zA-Z0-9_-]+$/;

const templateConfigFileSchema = z.object({
  serviceName: z.string().min(1).regex(nameRegex),
  fileName: z.string().min(1),
  volumeName: z.string().min(1),
  mountPath: z.string().min(1),
  // Either inline content or a file reference (relative to template directory)
  content: z.string().optional(),
  contentFile: z.string().optional(),
  permissions: z.string().regex(/^[0-7]{3,4}$/, "permissions must be a 3 or 4 digit octal value").optional(),
  owner: z.string().optional(),
}).refine(
  (data) => data.content != null || data.contentFile != null,
  { message: "Either 'content' or 'contentFile' must be provided" }
);

// Shares its field set with `stackServiceDefinitionSchema` via
// `stackServiceCommonFieldsSchema` so adding a new common field can't drift
// silently (customer feedback #1). Leaf-specific fields and the
// stricter-than-HTTP refine (Stateful must not have routing) stay here.
const templateServiceSchema = stackServiceCommonFieldsSchema
  .refine(
    (data) => {
      if (data.serviceType === "StatelessWeb" && !data.routing) return false;
      if (data.serviceType === "AdoptedWeb" && !data.routing) return false;
      if (data.serviceType === "Stateful" && data.routing) return false;
      return true;
    },
    { message: "StatelessWeb/AdoptedWeb services must have routing; Stateful services must not have routing" }
  )
  .superRefine((data, ctx) => {
    refineAddonsBlock(data.addons, ctx, productionAddonRegistry);
  });

// =====================
// Vault Section Schema (composed from canonical sub-schemas)
// =====================

const templateVaultSchema = z.object({
  policies: z.array(templateVaultPolicySchema).optional(),
  appRoles: z.array(templateVaultAppRoleSchema).optional(),
  kv: z.array(templateVaultKvSchema).optional(),
});

const templateNatsSchema = z.object({
  // App-author surface (Phase 1 additions). Reuse canonical strict shapes
  // from stack-template-schemas.ts so file-loaded templates can't sneak in
  // wildcards or `$SYS.*` prefixes that the HTTP draft path rejects.
  subjectPrefix: templateNatsSubjectPrefixSchema.optional(),
  roles: z.array(templateNatsRoleSchema).optional(),
  signers: z.array(templateNatsSignerSchema).optional(),
  exports: z.array(natsRelativeSubjectSchema).optional(),
  imports: z.array(templateNatsImportSchema).optional(),
  // Legacy / system surface
  accounts: z.array(templateNatsAccountSchema).optional(),
  credentials: z.array(templateNatsCredentialSchema).optional(),
  streams: z.array(templateNatsStreamSchema).optional(),
  consumers: z.array(templateNatsConsumerSchema).optional(),
});

const postInstallActionSchema = z.object({
  type: z.string().min(1),
});

export const templateFileSchema = z.object({
  name: z.string().min(1).max(100).regex(nameRegex),
  displayName: z.string().min(1).max(200),
  builtinVersion: z.number().int().min(1),
  scope: z.enum(["host", "environment", "any"]),
  networkType: z.enum(["local", "internet"]).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  resourceOutputs: z.array(stackResourceOutputSchema).optional(),
  resourceInputs: z.array(stackResourceInputSchema).optional(),
  networkTypeDefaults: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  services: z.array(templateServiceSchema),
  configFiles: z.array(templateConfigFileSchema).optional(),
  postInstallActions: z.array(postInstallActionSchema).optional(),
  inputs: z.array(templateInputDeclSchema).optional(),
  vault: templateVaultSchema.optional(),
  nats: templateNatsSchema.optional(),
}).superRefine((data, ctx) => {
  const inputNames = new Set((data.inputs ?? []).map((i) => i.name));
  const policyNames = new Set((data.vault?.policies ?? []).map((p) => p.name));
  const appRoleNames = new Set((data.vault?.appRoles ?? []).map((a) => a.name));
  const natsAccountNames = new Set((data.nats?.accounts ?? []).map((a) => a.name));
  const natsCredentialNames = new Set((data.nats?.credentials ?? []).map((c) => c.name));
  const natsStreamNames = new Set((data.nats?.streams ?? []).map((s) => s.name));

  // Unique input names
  const seenInputNames = new Set<string>();
  for (const input of data.inputs ?? []) {
    if (seenInputNames.has(input.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate input name: '${input.name}'`, path: ["inputs"] });
    }
    seenInputNames.add(input.name);
  }

  // Unique policy names
  const seenPolicyNames = new Set<string>();
  for (const policy of data.vault?.policies ?? []) {
    if (seenPolicyNames.has(policy.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate policy name: '${policy.name}'`, path: ["vault", "policies"] });
    }
    seenPolicyNames.add(policy.name);
  }

  // Unique appRole names
  const seenAppRoleNames = new Set<string>();
  for (const appRole of data.vault?.appRoles ?? []) {
    if (seenAppRoleNames.has(appRole.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate appRole name: '${appRole.name}'`, path: ["vault", "appRoles"] });
    }
    seenAppRoleNames.add(appRole.name);
  }

  // Unique KV paths
  const seenKvPaths = new Set<string>();
  for (const kv of data.vault?.kv ?? []) {
    if (seenKvPaths.has(kv.path)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate KV path: '${kv.path}'`, path: ["vault", "kv"] });
    }
    seenKvPaths.add(kv.path);
  }

  // AppRole.policy refs must resolve to a policy name in this template
  for (const appRole of data.vault?.appRoles ?? []) {
    if (!policyNames.has(appRole.policy)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `AppRole '${appRole.name}' references unknown policy '${appRole.policy}' (defined policies: ${formatNameSet(policyNames)})`,
        path: ["vault", "appRoles"],
      });
    }
  }

  // KV fromInput refs must resolve to an input name in this template
  for (const kv of data.vault?.kv ?? []) {
    for (const [field, val] of Object.entries(kv.fields)) {
      if ("fromInput" in val) {
        if (!inputNames.has(val.fromInput)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `KV path '${kv.path}' field '${field}' references unknown input '${val.fromInput}' (defined inputs: ${formatNameSet(inputNames)})`,
            path: ["vault", "kv"],
          });
        }
      }
    }
  }

  // services[].vaultAppRoleRef must resolve to an appRole name in this template
  for (const svc of data.services) {
    if (svc.vaultAppRoleRef !== undefined && !appRoleNames.has(svc.vaultAppRoleRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' vaultAppRoleRef '${svc.vaultAppRoleRef}' references unknown appRole (defined: ${formatNameSet(appRoleNames)})`,
        path: ["services"],
      });
    }
  }

  for (const credential of data.nats?.credentials ?? []) {
    if (!natsAccountNames.has(credential.account)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `NATS credential '${credential.name}' references unknown account '${credential.account}' (defined: ${formatNameSet(natsAccountNames)})`,
        path: ["nats", "credentials"],
      });
    }
  }

  for (const stream of data.nats?.streams ?? []) {
    if (!natsAccountNames.has(stream.account)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `NATS stream '${stream.name}' references unknown account '${stream.account}' (defined: ${formatNameSet(natsAccountNames)})`,
        path: ["nats", "streams"],
      });
    }
  }

  for (const consumer of data.nats?.consumers ?? []) {
    if (!natsStreamNames.has(consumer.stream)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `NATS consumer '${consumer.name}' references unknown stream '${consumer.stream}' (defined: ${formatNameSet(natsStreamNames)})`,
        path: ["nats", "consumers"],
      });
    }
  }

  const natsRoleNames = new Set((data.nats?.roles ?? []).map((r) => r.name));
  const natsSignerNames = new Set((data.nats?.signers ?? []).map((s) => s.name));

  for (const svc of data.services) {
    if (svc.natsCredentialRef !== undefined && !natsCredentialNames.has(svc.natsCredentialRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' natsCredentialRef '${svc.natsCredentialRef}' references unknown credential (defined: ${formatNameSet(natsCredentialNames)})`,
        path: ["services"],
      });
    }
    if (svc.natsRole !== undefined && !natsRoleNames.has(svc.natsRole)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' natsRole '${svc.natsRole}' references unknown role (defined: ${formatNameSet(natsRoleNames)})`,
        path: ["services"],
      });
    }
    if (svc.natsSigner !== undefined && !natsSignerNames.has(svc.natsSigner)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service '${svc.serviceName}' natsSigner '${svc.natsSigner}' references unknown signer (defined: ${formatNameSet(natsSignerNames)})`,
        path: ["services"],
      });
    }
  }

  validateNatsSectionShape(data.nats, ctx);
});

export type TemplateFileDefinition = z.infer<typeof templateFileSchema>;

export type TemplateInput = z.infer<typeof templateInputDeclSchema>;
export type TemplateVaultPolicy = z.infer<typeof templateVaultPolicySchema>;
export type TemplateVaultAppRole = z.infer<typeof templateVaultAppRoleSchema>;
export type TemplateVaultKv = z.infer<typeof templateVaultKvSchema>;
export type TemplateVault = z.infer<typeof templateVaultSchema>;
export type TemplateNats = z.infer<typeof templateNatsSchema>;

function formatNameSet(set: Set<string>): string {
  if (set.size === 0) return "none defined";
  return Array.from(set)
    .map((n) => `'${n}'`)
    .join(", ");
}

// =====================
// Env-var substitution
// =====================

/**
 * Substitute ${VAR_NAME} tokens in a string using process.env.
 * Tokens for which no env var is set are left as-is so validation
 * errors surface clearly rather than silently producing an empty string.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (match, name: string) => {
    const resolved = process.env[name];
    return resolved !== undefined ? resolved : match;
  });
}

// =====================
// Loader
// =====================

export interface PostInstallAction {
  type: string;
}

export interface LoadedTemplate {
  name: string;
  displayName: string;
  builtinVersion: number;
  scope: "host" | "environment" | "any";
  networkType?: "local" | "internet";
  category?: string;
  description?: string;
  postInstallActions?: PostInstallAction[];
  inputs?: TemplateInput[];
  vault?: TemplateVault;
  nats?: TemplateNats;
  definition: {
    name: string;
    description?: string;
    parameters?: z.infer<typeof stackParameterDefinitionSchema>[];
    resourceOutputs?: z.infer<typeof stackResourceOutputSchema>[];
    resourceInputs?: z.infer<typeof stackResourceInputSchema>[];
    networkTypeDefaults?: Record<string, Record<string, string | number | boolean>>;
    networks: z.infer<typeof stackNetworkSchema>[];
    volumes: z.infer<typeof stackVolumeSchema>[];
    services: Array<{
      serviceName: string;
      serviceType: typeof STACK_SERVICE_TYPES[number];
      dockerImage: string;
      dockerTag: string;
      containerConfig: z.infer<typeof stackContainerConfigSchema>;
      configFiles?: Array<{ volumeName: string; path: string; content: string; permissions?: string; ownerUid?: number; ownerGid?: number }>;
      initCommands?: z.infer<typeof stackInitCommandSchema>[];
      dependsOn: string[];
      order: number;
      routing?: z.infer<typeof stackServiceRoutingSchema>;
      vaultAppRoleRef?: string;
      natsCredentialRef?: string;
      natsRole?: string;
      natsSigner?: string;
    }>;
  };
  configFiles: StackTemplateConfigFileInput[];
}

/**
 * Load and validate a template from a directory containing template.json
 * and optional config files referenced by contentFile paths.
 */
export function loadTemplateFromDirectory(templateDir: string): LoadedTemplate {
  const templateJsonPath = path.join(templateDir, "template.json");

  if (!fs.existsSync(templateJsonPath)) {
    throw new TemplateFileError(`template.json not found in ${templateDir}`);
  }

  const rawContent = fs.readFileSync(templateJsonPath, "utf-8");
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawContent);
  } catch (e) {
    throw new TemplateFileError(`Invalid JSON in ${templateJsonPath}: ${(e as Error).message}`);
  }

  return loadTemplateFromObject(rawJson, templateDir);
}

/**
 * Load and validate a template from a parsed JSON object.
 * If templateDir is provided, contentFile references are resolved relative to it.
 * If not provided, all config files must use inline content.
 */
export function loadTemplateFromObject(
  rawJson: unknown,
  templateDir?: string
): LoadedTemplate {
  // Validate against schema
  const parsed = templateFileSchema.safeParse(rawJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new TemplateFileError(`Template validation failed: ${issues}`);
  }

  const data = parsed.data;

  // Resolve config file content
  const resolvedConfigFiles: StackTemplateConfigFileInput[] = [];
  for (const cf of data.configFiles ?? []) {
    let content: string;

    if (cf.content != null) {
      content = cf.content;
    } else if (cf.contentFile != null) {
      if (!templateDir) {
        throw new TemplateFileError(
          `Config file "${cf.fileName}" uses contentFile but no template directory was provided`
        );
      }
      const filePath = path.resolve(templateDir, cf.contentFile);
      if (!filePath.startsWith(path.resolve(templateDir) + path.sep)) {
        throw new TemplateFileError(
          `contentFile path traversal detected: ${cf.contentFile}`
        );
      }
      if (!fs.existsSync(filePath)) {
        throw new TemplateFileError(
          `Referenced config file not found: ${cf.contentFile} (resolved to ${filePath})`
        );
      }
      content = fs.readFileSync(filePath, "utf-8");
    } else {
      throw new TemplateFileError(
        `Config file "${cf.fileName}" has neither content nor contentFile`
      );
    }

    resolvedConfigFiles.push({
      serviceName: cf.serviceName,
      fileName: cf.fileName,
      volumeName: cf.volumeName,
      mountPath: cf.mountPath,
      content,
      permissions: cf.permissions,
      owner: cf.owner,
    });
  }

  // Build the StackDefinition-compatible shape with config files embedded in services
  const configsByService = new Map<string, typeof resolvedConfigFiles>();
  for (const cf of resolvedConfigFiles) {
    const list = configsByService.get(cf.serviceName) ?? [];
    list.push(cf);
    configsByService.set(cf.serviceName, list);
  }

  const services = data.services.map((svc) => {
    const svcConfigs = configsByService.get(svc.serviceName) ?? [];
    return {
      serviceName: svc.serviceName,
      serviceType: svc.serviceType,
      dockerImage: resolveEnvVars(svc.dockerImage),
      dockerTag: resolveEnvVars(svc.dockerTag),
      containerConfig: svc.containerConfig,
      configFiles: svcConfigs.length > 0
        ? svcConfigs.map((cf) => ({
            volumeName: cf.volumeName,
            path: cf.mountPath,
            content: cf.content,
            permissions: cf.permissions,
          }))
        : undefined,
      initCommands: svc.initCommands,
      dependsOn: svc.dependsOn,
      order: svc.order,
      routing: svc.routing,
      vaultAppRoleRef: svc.vaultAppRoleRef,
      natsCredentialRef: svc.natsCredentialRef,
      natsRole: svc.natsRole,
      natsSigner: svc.natsSigner,
    };
  });

  return {
    name: data.name,
    displayName: data.displayName,
    builtinVersion: data.builtinVersion,
    scope: data.scope,
    networkType: data.networkType,
    category: data.category,
    description: data.description,
    postInstallActions: data.postInstallActions,
    inputs: data.inputs,
    vault: data.vault,
    nats: data.nats,
    definition: {
      name: data.name,
      description: data.description,
      parameters: data.parameters,
      resourceOutputs: data.resourceOutputs,
      resourceInputs: data.resourceInputs,
      networkTypeDefaults: data.networkTypeDefaults,
      networks: data.networks,
      volumes: data.volumes,
      services,
    },
    configFiles: resolvedConfigFiles,
  };
}

/**
 * Discover and load all templates from a templates directory.
 * Each subdirectory containing a template.json is loaded.
 */
export function discoverTemplates(templatesDir: string): LoadedTemplate[] {
  if (!fs.existsSync(templatesDir)) {
    return [];
  }

  const entries = fs.readdirSync(templatesDir, { withFileTypes: true });
  const templates: LoadedTemplate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const templateDir = path.join(templatesDir, entry.name);
    const templateJsonPath = path.join(templateDir, "template.json");

    if (!fs.existsSync(templateJsonPath)) continue;

    templates.push(loadTemplateFromDirectory(templateDir));
  }

  return templates;
}

// =====================
// Error class
// =====================

export class TemplateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateFileError";
  }
}
