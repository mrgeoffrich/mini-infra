import { z } from "zod";

// Sub-schemas for JSON field shapes

export const stackContainerConfigSchema = z.object({
  command: z.array(z.string()).optional(),
  entrypoint: z.array(z.string()).optional(),
  user: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  ports: z
    .array(
      z.object({
        containerPort: z.number().int().min(1).max(65535),
        hostPort: z.number().int().min(1).max(65535),
        protocol: z.enum(["tcp", "udp"]),
      })
    )
    .optional(),
  mounts: z
    .array(
      z.object({
        source: z.string().min(1),
        target: z.string().min(1),
        type: z.enum(["volume", "bind"]),
        readOnly: z.boolean().optional(),
      })
    )
    .optional(),
  labels: z.record(z.string(), z.string()).optional(),
  restartPolicy: z
    .enum(["no", "always", "unless-stopped", "on-failure"])
    .optional(),
  healthcheck: z
    .object({
      test: z.array(z.string()),
      interval: z.number().int().min(1),
      timeout: z.number().int().min(1),
      retries: z.number().int().min(1),
      startPeriod: z.number().int().min(0),
    })
    .optional(),
  logConfig: z
    .object({
      type: z.string(),
      maxSize: z.string(),
      maxFile: z.string(),
    })
    .optional(),
});

export const stackConfigFileSchema = z.object({
  volumeName: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  permissions: z.string().optional(),
  ownerUid: z.number().int().min(0).optional(),
  ownerGid: z.number().int().min(0).optional(),
});

export const stackInitCommandSchema = z.object({
  volumeName: z.string().min(1),
  mountPath: z.string().min(1),
  commands: z.array(z.string().min(1)),
});

export const stackServiceRoutingSchema = z.object({
  hostname: z.string().min(1).max(253),
  listeningPort: z.number().int().min(1).max(65535),
  enableSsl: z.boolean().optional(),
  tlsCertificateId: z.string().optional(),
  backendOptions: z
    .object({
      balanceAlgorithm: z
        .enum(["roundrobin", "leastconn", "source"])
        .optional(),
      checkTimeout: z.number().int().min(0).optional(),
      connectTimeout: z.number().int().min(0).optional(),
      serverTimeout: z.number().int().min(0).optional(),
    })
    .optional(),
  dns: z
    .object({
      provider: z.enum(["cloudflare", "external"]),
      zoneId: z.string().optional(),
      recordType: z.enum(["A", "CNAME"]).optional(),
      proxied: z.boolean().optional(),
    })
    .optional(),
});

export const stackNetworkSchema = z.object({
  name: z.string().min(1),
  driver: z.string().optional(),
  options: z.record(z.string(), z.any()).optional(),
});

export const stackVolumeSchema = z.object({
  name: z.string().min(1),
  driver: z.string().optional(),
  options: z.record(z.string(), z.any()).optional(),
});

const serviceNameRegex = /^[a-zA-Z0-9_-]+$/;

export const stackServiceDefinitionSchema = z
  .object({
    serviceName: z
      .string()
      .min(1)
      .max(100)
      .regex(
        serviceNameRegex,
        "Service name can only contain letters, numbers, hyphens, and underscores"
      ),
    serviceType: z.enum(["Stateful", "StatelessWeb"]),
    dockerImage: z.string().min(1),
    dockerTag: z.string().min(1),
    containerConfig: stackContainerConfigSchema,
    configFiles: z.array(stackConfigFileSchema).optional(),
    initCommands: z.array(stackInitCommandSchema).optional(),
    dependsOn: z.array(z.string()),
    order: z.number().int().min(0),
    routing: stackServiceRoutingSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.serviceType === "StatelessWeb" && !data.routing) {
        return false;
      }
      if (data.serviceType === "Stateful" && data.routing) {
        return false;
      }
      return true;
    },
    {
      message:
        "StatelessWeb services must have routing; Stateful services must not have routing",
    }
  );

// The portable StackDefinition shape (no DB fields)
export const stackDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      serviceNameRegex,
      "Stack name can only contain letters, numbers, hyphens, and underscores"
    ),
  description: z.string().max(500).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  services: z
    .array(stackServiceDefinitionSchema)
    .min(1, "At least one service is required"),
});

// API request schemas

export const createStackSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      serviceNameRegex,
      "Stack name can only contain letters, numbers, hyphens, and underscores"
    ),
  description: z.string().max(500).optional(),
  environmentId: z.string().min(1).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  services: z
    .array(stackServiceDefinitionSchema)
    .min(1, "At least one service is required"),
});

export const updateStackSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      serviceNameRegex,
      "Stack name can only contain letters, numbers, hyphens, and underscores"
    )
    .optional(),
  description: z.string().max(500).optional(),
  networks: z.array(stackNetworkSchema).optional(),
  volumes: z.array(stackVolumeSchema).optional(),
  services: z.array(stackServiceDefinitionSchema).optional(),
});

export const updateStackServiceSchema = z.object({
  serviceType: z.enum(["Stateful", "StatelessWeb"]).optional(),
  dockerImage: z.string().min(1).optional(),
  dockerTag: z.string().min(1).optional(),
  containerConfig: stackContainerConfigSchema.optional(),
  configFiles: z.array(stackConfigFileSchema).optional(),
  initCommands: z.array(stackInitCommandSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
  order: z.number().int().min(0).optional(),
  routing: stackServiceRoutingSchema.nullable().optional(),
});

export const applyStackSchema = z.object({
  serviceNames: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
});
