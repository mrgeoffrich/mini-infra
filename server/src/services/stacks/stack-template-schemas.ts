import { z } from "zod";
import {
  stackParameterDefinitionSchema,
  parameterValuesSchema,
  stackNetworkSchema,
  stackVolumeSchema,
  stackServiceDefinitionSchema,
} from "./schemas";

const nameRegex = /^[a-zA-Z0-9_-]+$/;

const templateNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    nameRegex,
    "Template name can only contain letters, numbers, hyphens, and underscores"
  );

const configFileInputSchema = z.object({
  serviceName: z
    .string()
    .min(1)
    .max(100)
    .regex(nameRegex, "Service name can only contain letters, numbers, hyphens, and underscores"),
  fileName: z.string().min(1),
  volumeName: z.string().min(1),
  mountPath: z.string().min(1),
  content: z.string(),
  permissions: z.string().optional(),
  owner: z.string().optional(),
});

export const createTemplateSchema = z.object({
  name: templateNameSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  scope: z.enum(["host", "environment"]),
  category: z.string().max(100).optional(),
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  defaultParameterValues: parameterValuesSchema.optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  services: z
    .array(stackServiceDefinitionSchema)
    .min(1, "At least one service is required"),
  configFiles: z.array(configFileInputSchema).optional(),
});

export const updateTemplateMetaSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  category: z.string().max(100).optional(),
});

export const draftVersionSchema = z.object({
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  defaultParameterValues: parameterValuesSchema.optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  services: z
    .array(stackServiceDefinitionSchema)
    .min(1, "At least one service is required"),
  configFiles: z.array(configFileInputSchema).optional(),
  notes: z.string().max(1000).optional(),
});

export const publishDraftSchema = z.object({
  notes: z.string().max(1000).optional(),
});

export const instantiateTemplateSchema = z.object({
  environmentId: z.string().min(1).optional(),
  parameterValues: parameterValuesSchema.optional(),
  name: z.string().min(1).max(100).optional(),
});
