import { z } from "zod";

// Port schema
export const deploymentPortSchema = z.object({
  containerPort: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536"),
  hostPort: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536")
    .optional(),
  protocol: z.enum(["tcp", "udp"]).optional().default("tcp"),
});

// Volume schema
export const deploymentVolumeSchema = z.object({
  hostPath: z
    .string()
    .min(1, "Host path is required")
    .max(500, "Host path must be less than 500 characters"),
  containerPath: z
    .string()
    .min(1, "Container path is required")
    .max(500, "Container path must be less than 500 characters"),
  mode: z.enum(["rw", "ro"]).optional().default("rw"),
});

// Environment variable schema
export const containerEnvVarSchema = z.object({
  name: z
    .string()
    .min(1, "Environment variable name is required")
    .max(255, "Name must be less than 255 characters")
    .regex(
      /^[A-Z_][A-Z0-9_]*$/,
      "Name must start with letter or underscore and contain only uppercase letters, numbers, and underscores",
    ),
  value: z.string().max(1000, "Value must be less than 1000 characters"),
});

// Container configuration schema
export const containerConfigSchema = z.object({
  ports: z.array(deploymentPortSchema).default([]),
  volumes: z.array(deploymentVolumeSchema).default([]),
  environment: z.array(containerEnvVarSchema).default([]),
  labels: z.record(z.string(), z.string()).default({}),
  networks: z.array(z.string()).default([]),
});

// Health check schema
export const healthCheckConfigSchema = z.object({
  endpoint: z
    .string()
    .min(1, "Health check endpoint is required")
    .url("Must be a valid URL or path starting with / or http"),
  method: z.enum(["GET", "POST"]).default("GET"),
  expectedStatus: z
    .array(
      z
        .number()
        .int()
        .min(100, "Status code must be between 100-599")
        .max(599, "Status code must be between 100-599"),
    )
    .min(1, "At least one expected status code is required")
    .default([200]),
  responseValidation: z
    .string()
    .max(500, "Response validation pattern must be less than 500 characters")
    .optional(),
  timeout: z
    .number()
    .int()
    .min(1000, "Timeout must be at least 1000ms")
    .max(60000, "Timeout must be less than 60000ms")
    .default(10000),
  retries: z
    .number()
    .int()
    .min(0, "Retries must be 0 or greater")
    .max(10, "Retries must be 10 or less")
    .default(3),
  interval: z
    .number()
    .int()
    .min(1000, "Interval must be at least 1000ms")
    .max(300000, "Interval must be less than 300000ms")
    .default(30000),
});

// HAProxy configuration schema
export const haproxyConfigSchema = z.object({
  backendName: z
    .string()
    .min(1, "Backend name is required")
    .max(255, "Backend name must be less than 255 characters")
    .regex(
      /^[a-z0-9-]+$/,
      "Backend name can only contain lowercase letters, numbers, and hyphens",
    ),
  frontendName: z
    .string()
    .min(1, "Frontend name is required")
    .max(255, "Frontend name must be less than 255 characters")
    .regex(
      /^[a-z0-9-]+$/,
      "Frontend name can only contain lowercase letters, numbers, and hyphens",
    ),
  hostRule: z
    .string()
    .min(1, "Host rule is required")
    .max(500, "Rule must be less than 500 characters"),
  pathRule: z.string().optional(),
  ssl: z.boolean().default(false),
});

// Rollback configuration schema
export const rollbackConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxWaitTime: z
    .number()
    .int()
    .min(30000, "Max wait time must be at least 30 seconds")
    .max(3600000, "Max wait time must be less than 1 hour")
    .default(300000),
  keepOldContainer: z.boolean().default(false),
});

// Hostname validation schema
export const hostnameSchema = z
  .string()
  .min(1, "Hostname is required")
  .max(253, "Hostname must be 253 characters or less")
  .regex(
    /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
    "Hostname must be a valid domain name (e.g., example.com, api.example.com)",
  )
  .optional();

// Complete deployment configuration schema (matches CreateDeploymentConfigRequest)
export const deploymentConfigSchema = z.object({
  environmentId: z
    .string()
    .min(1, "Environment is required"),
  applicationName: z
    .string()
    .min(1, "Application name is required")
    .max(255, "Application name must be less than 255 characters")
    .regex(
      /^[a-z0-9-]+$/,
      "Application name can only contain lowercase letters, numbers, and hyphens",
    ),
  dockerImage: z
    .string()
    .min(1, "Docker image is required")
    .max(500, "Docker image must be less than 500 characters"),
  dockerTag: z
    .string()
    .min(1, "Docker tag is required")
    .max(100, "Docker tag must be less than 100 characters")
    .default("latest"),
  dockerRegistry: z
    .string()
    .max(500, "Docker registry must be less than 500 characters")
    .optional(),
  hostname: hostnameSchema,
  enableSsl: z.boolean().optional().default(false),
  listeningPort: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536")
    .optional(),
  containerConfig: containerConfigSchema,
  healthCheckConfig: healthCheckConfigSchema,
  haproxyConfig: haproxyConfigSchema,
  rollbackConfig: rollbackConfigSchema,
});

// Form data types
export type DeploymentPortFormData = z.infer<typeof deploymentPortSchema>;
export type DeploymentVolumeFormData = z.infer<typeof deploymentVolumeSchema>;
export type ContainerEnvVarFormData = z.infer<typeof containerEnvVarSchema>;
export type ContainerConfigFormData = z.infer<typeof containerConfigSchema>;
export type HealthCheckConfigFormData = z.infer<typeof healthCheckConfigSchema>;
export type HAProxyConfigFormData = z.infer<typeof haproxyConfigSchema>;
export type RollbackConfigFormData = z.infer<typeof rollbackConfigSchema>;
export type DeploymentConfigFormData = z.infer<typeof deploymentConfigSchema>;

// Hostname validation form data
export type HostnameFormData = z.infer<typeof hostnameSchema>;
