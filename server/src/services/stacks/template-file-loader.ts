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
} from "./schemas";
import type { StackTemplateConfigFileInput } from "@mini-infra/types";

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

const templateServiceSchema = z.object({
  serviceName: z.string().min(1).max(100).regex(nameRegex, "Service name can only contain letters, numbers, hyphens, and underscores"),
  serviceType: z.enum(["Stateful", "StatelessWeb"]),
  dockerImage: z.string().min(1),
  dockerTag: z.string().min(1),
  containerConfig: stackContainerConfigSchema,
  initCommands: z.array(stackInitCommandSchema).optional(),
  dependsOn: z.array(z.string()),
  order: z.number().int().min(0),
  routing: stackServiceRoutingSchema.optional(),
}).refine(
  (data) => {
    if (data.serviceType === "StatelessWeb" && !data.routing) return false;
    if (data.serviceType === "Stateful" && data.routing) return false;
    return true;
  },
  { message: "StatelessWeb services must have routing; Stateful services must not have routing" }
);

export const templateFileSchema = z.object({
  name: z.string().min(1).max(100).regex(nameRegex),
  displayName: z.string().min(1).max(200),
  builtinVersion: z.number().int().min(1),
  scope: z.enum(["host", "environment"]),
  category: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  services: z.array(templateServiceSchema).min(1, "At least one service is required"),
  configFiles: z.array(templateConfigFileSchema).optional(),
});

export type TemplateFileDefinition = z.infer<typeof templateFileSchema>;

// =====================
// Loader
// =====================

export interface LoadedTemplate {
  name: string;
  displayName: string;
  builtinVersion: number;
  scope: "host" | "environment";
  category?: string;
  description?: string;
  definition: {
    name: string;
    description?: string;
    parameters?: z.infer<typeof stackParameterDefinitionSchema>[];
    networks: z.infer<typeof stackNetworkSchema>[];
    volumes: z.infer<typeof stackVolumeSchema>[];
    services: Array<{
      serviceName: string;
      serviceType: "Stateful" | "StatelessWeb";
      dockerImage: string;
      dockerTag: string;
      containerConfig: any;
      configFiles?: Array<{ volumeName: string; path: string; content: string; permissions?: string; ownerUid?: number; ownerGid?: number }>;
      initCommands?: any[];
      dependsOn: string[];
      order: number;
      routing?: any;
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
      dockerImage: svc.dockerImage,
      dockerTag: svc.dockerTag,
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
    };
  });

  return {
    name: data.name,
    displayName: data.displayName,
    builtinVersion: data.builtinVersion,
    scope: data.scope,
    category: data.category,
    description: data.description,
    definition: {
      name: data.name,
      description: data.description,
      parameters: data.parameters,
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
