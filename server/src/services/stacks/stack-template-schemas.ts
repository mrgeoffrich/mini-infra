import { z } from "zod";
import { ENVIRONMENT_NETWORK_TYPES } from "@mini-infra/types";
import {
  stackParameterDefinitionSchema,
  parameterValuesSchema,
  stackNetworkSchema,
  stackVolumeSchema,
  stackServiceDefinitionSchema,
  stackResourceOutputSchema,
  stackResourceInputSchema,
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
  // Must be a safe absolute path — matches `stackInitCommandSchema.mountPath`.
  // Prevents `../../etc/passwd`-style escapes when a template is instantiated.
  mountPath: z
    .string()
    .min(1)
    .regex(/^\/[a-zA-Z0-9_./-]*$/, "mountPath must be a safe absolute path"),
  content: z.string(),
  permissions: z.string().optional(),
  owner: z.string().optional(),
});

// `partialRecord` — keys are validated against the environment-network-type
// enum, but it's OK for a template to set defaults for only some network types
// (or none). A plain `z.record(enum, ...)` would require every enum value.
const networkTypeDefaultsSchema = z.partialRecord(
  z.enum(ENVIRONMENT_NETWORK_TYPES),
  parameterValuesSchema,
);

export const createTemplateSchema = z.object({
  name: templateNameSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  scope: z.enum(["host", "environment"]),
  networkType: z.enum(ENVIRONMENT_NETWORK_TYPES).optional(),
  environmentId: z.string().min(1).optional(),
  category: z.string().max(100).optional(),
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  defaultParameterValues: parameterValuesSchema.optional(),
  networkTypeDefaults: networkTypeDefaultsSchema.optional(),
  resourceOutputs: z.array(stackResourceOutputSchema).optional(),
  resourceInputs: z.array(stackResourceInputSchema).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  // Drafts may be empty — the "at least one service" constraint is enforced
  // at publish time, so users can create a template and fill it in gradually.
  services: z.array(stackServiceDefinitionSchema),
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
  networkTypeDefaults: networkTypeDefaultsSchema.optional(),
  resourceOutputs: z.array(stackResourceOutputSchema).optional(),
  resourceInputs: z.array(stackResourceInputSchema).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  // See createTemplateSchema: the "at least one service" rule is a publish
  // check, not a draft check.
  services: z.array(stackServiceDefinitionSchema),
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
