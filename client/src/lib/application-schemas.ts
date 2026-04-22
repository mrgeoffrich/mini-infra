import { z } from "zod";
import {
  STACK_SERVICE_TYPES,
  RESTART_POLICIES,
  NETWORK_PROTOCOLS,
} from "@mini-infra/types";

// ---- Shared sub-schemas for application forms ----

export const envVarSchema = z.object({
  key: z.string().min(1, "Key is required"),
  value: z.string(),
});

export const portMappingSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535),
  protocol: z.enum(NETWORK_PROTOCOLS),
});

export const volumeMountSchema = z.object({
  name: z.string().min(1, "Volume name is required"),
  mountPath: z.string().min(1, "Mount path is required"),
});

export const healthCheckSchema = z.object({
  test: z.string().min(1, "Health check command is required"),
  interval: z.number().int().min(1, "Must be at least 1s"),
  timeout: z.number().int().min(1, "Must be at least 1s"),
  retries: z.number().int().min(1).max(20),
  startPeriod: z.number().int().min(0),
});

export const routingSchema = z.object({
  hostname: z.string().min(1, "Hostname is required"),
  listeningPort: z.number().int().min(1).max(65535),
  enableSsl: z.boolean().optional(),
  enableTunnel: z.boolean().optional(),
});

export const serviceNameSchema = z
  .string()
  .min(1, "Service name is required")
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/,
    "Must be lowercase, alphanumeric with hyphens, no leading/trailing hyphens",
  );

// ---- Create form schema (includes deploy + health check options) ----

export const createApplicationFormSchema = z.object({
  displayName: z.string().min(1, "Application name is required").max(100),
  serviceName: serviceNameSchema,
  serviceType: z.enum(STACK_SERVICE_TYPES),
  environmentId: z.string().min(1, "Environment is required"),
  dockerImage: z.string().min(1, "Docker image is required"),
  dockerTag: z.string().min(1, "Tag is required"),
  ports: z.array(portMappingSchema),
  envVars: z.array(envVarSchema),
  volumeMounts: z.array(volumeMountSchema),
  enableRouting: z.boolean(),
  routing: routingSchema.optional(),
  restartPolicy: z.enum(RESTART_POLICIES),
  enableHealthCheck: z.boolean(),
  healthCheck: healthCheckSchema.optional(),
  deployImmediately: z.boolean(),
});

export type CreateApplicationFormData = z.infer<
  typeof createApplicationFormSchema
>;

export const createApplicationDefaults: CreateApplicationFormData = {
  displayName: "",
  serviceName: "web",
  serviceType: "StatelessWeb",
  environmentId: "",
  dockerImage: "",
  dockerTag: "latest",
  ports: [],
  envVars: [],
  volumeMounts: [],
  enableRouting: true,
  routing: { hostname: "", listeningPort: 8080 },
  restartPolicy: "unless-stopped",
  enableHealthCheck: false,
  healthCheck: {
    test: "curl -f http://localhost/ || exit 1",
    interval: 30,
    timeout: 10,
    retries: 3,
    startPeriod: 15,
  },
  deployImmediately: true,
};

// ---- Edit form schema (no deploy option, adds SSL/tunnel) ----

export const editApplicationFormSchema = z.object({
  displayName: z.string().min(1, "Application name is required").max(100),
  description: z.string().max(500).optional(),
  serviceName: serviceNameSchema,
  serviceType: z.enum(STACK_SERVICE_TYPES),
  dockerImage: z.string().min(1, "Docker image is required"),
  dockerTag: z.string().min(1, "Tag is required"),
  ports: z.array(portMappingSchema),
  envVars: z.array(envVarSchema),
  volumeMounts: z.array(volumeMountSchema),
  enableRouting: z.boolean(),
  routing: routingSchema.optional(),
  restartPolicy: z.enum(RESTART_POLICIES),
});

export type EditApplicationFormData = z.infer<
  typeof editApplicationFormSchema
>;
