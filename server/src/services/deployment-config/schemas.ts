import { z } from "zod";

// ====================
// Zod Validation Schemas
// ====================

const deploymentPortSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(["tcp", "udp"]).optional(),
});

const deploymentVolumeSchema = z.object({
  hostPath: z.string().min(1),
  containerPath: z.string().min(1),
  mode: z.enum(["rw", "ro"]).optional(),
});

const containerEnvVarSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});

const containerConfigSchema = z.object({
  ports: z.array(deploymentPortSchema),
  volumes: z.array(deploymentVolumeSchema),
  environment: z.array(containerEnvVarSchema),
  labels: z.record(z.string(), z.string()),
  networks: z.array(z.string()),
});

const healthCheckConfigSchema = z.object({
  endpoint: z.string().min(1),
  method: z.enum(["GET", "POST"]),
  expectedStatus: z.array(z.number().int().min(100).max(599)),
  responseValidation: z.string().optional(),
  timeout: z.number().int().min(1000),
  retries: z.number().int().min(1),
  interval: z.number().int().min(1000),
});


const rollbackConfigSchema = z.object({
  enabled: z.boolean(),
  maxWaitTime: z.number().int().min(1000),
  keepOldContainer: z.boolean(),
});

export const createDeploymentConfigSchema = z.object({
  applicationName: z
    .string()
    .min(1, "Application name is required")
    .max(100, "Application name must be 100 characters or less")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Application name can only contain letters, numbers, hyphens, and underscores",
    ),
  dockerImage: z.string().min(1, "Docker image is required"),
  dockerTag: z.string().optional().default("latest"),
  dockerRegistry: z.string().optional(),
  containerConfig: containerConfigSchema,
  healthCheckConfig: healthCheckConfigSchema,
  rollbackConfig: rollbackConfigSchema,
  listeningPort: z.number().int().min(1).max(65535).optional(),
  hostname: z
    .string()
    .min(1, "Hostname cannot be empty")
    .max(253, "Hostname must be 253 characters or less")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/,
      "Hostname must be a valid domain name (e.g., example.com, api.example.com)",
    )
    .optional(),
  enableSsl: z.boolean().optional(),
  environmentId: z.string().min(1, "Environment ID is required"),
});

export const updateDeploymentConfigSchema = z.object({
  applicationName: z
    .string()
    .min(1, "Application name is required")
    .max(100, "Application name must be 100 characters or less")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Application name can only contain letters, numbers, hyphens, and underscores",
    )
    .optional(),
  dockerImage: z.string().min(1, "Docker image is required").optional(),
  dockerTag: z.string().optional(),
  dockerRegistry: z.string().optional(),
  containerConfig: containerConfigSchema.optional(),
  healthCheckConfig: healthCheckConfigSchema.optional(),
  rollbackConfig: rollbackConfigSchema.optional(),
  listeningPort: z.number().int().min(1).max(65535).optional(),
  hostname: z
    .string()
    .min(1, "Hostname cannot be empty")
    .max(253, "Hostname must be 253 characters or less")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/,
      "Hostname must be a valid domain name (e.g., example.com, api.example.com)",
    )
    .optional(),
  enableSsl: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
