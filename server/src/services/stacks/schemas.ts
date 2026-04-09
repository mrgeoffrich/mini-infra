import { z } from "zod";

// Template string pattern: allows {{params.key-name}} references
const templateStringPattern = /\{\{params\.[a-zA-Z0-9_-]+\}\}/;

// A value that can be either a literal number or a template string
const numberOrTemplate = z.union([
  z.number().int().min(1).max(65535),
  z.string().regex(templateStringPattern, "Must be a {{params.name}} template reference"),
]);

const numberOrTemplateMin0 = z.union([
  z.number().int().min(0),
  z.string().regex(templateStringPattern, "Must be a {{params.name}} template reference"),
]);

const numberOrTemplateMin1 = z.union([
  z.number().int().min(1),
  z.string().regex(templateStringPattern, "Must be a {{params.name}} template reference"),
]);

const booleanOrTemplate = z.union([
  z.boolean(),
  z.string().regex(templateStringPattern, "Must be a {{params.name}} template reference"),
]);

// Stack parameter schemas

const stackParameterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const stackParameterDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, "Parameter name can only contain letters, numbers, hyphens, and underscores"),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().max(500).optional(),
  default: stackParameterValueSchema,
  validation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
      options: z.array(stackParameterValueSchema).optional(),
    })
    .optional(),
});

export const parameterValuesSchema = z.record(
  z.string(),
  stackParameterValueSchema
);

// Sub-schemas for JSON field shapes

export const stackContainerConfigSchema = z.object({
  command: z.array(z.string()).optional(),
  entrypoint: z.array(z.string()).optional(),
  user: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  ports: z
    .array(
      z.object({
        containerPort: numberOrTemplate,
        hostPort: numberOrTemplate,
        protocol: z.enum(["tcp", "udp"]),
        exposeOnHost: booleanOrTemplate.optional(),
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
      }).refine(
        (m) => {
          if (m.type !== "bind") return true;
          // Block bind mounts to sensitive host paths
          const blocked = ["/", "/etc", "/proc", "/sys", "/root", "/dev", "/boot"];
          const normalized = m.source.replace(/\/+$/, "") || "/";
          return !blocked.includes(normalized);
        },
        { message: "Bind mount source points to a restricted host path" }
      )
    )
    .optional(),
  labels: z.record(z.string(), z.string()).optional(),
  joinNetworks: z.array(z.string().min(1)).optional(),
  joinResourceNetworks: z.array(z.string().min(1)).optional(),
  restartPolicy: z
    .enum(["no", "always", "unless-stopped", "on-failure"])
    .optional(),
  healthcheck: z
    .object({
      test: z.array(z.string()),
      interval: numberOrTemplateMin1,
      timeout: numberOrTemplateMin1,
      retries: numberOrTemplateMin1,
      startPeriod: numberOrTemplateMin0,
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
  path: z.string().min(1).regex(/^[a-zA-Z0-9_.\/\-]+$/, "path must contain only safe characters"),
  content: z.string(),
  permissions: z.string().regex(/^[0-7]{3,4}$/, "permissions must be a 3 or 4 digit octal value").optional(),
  ownerUid: z.number().int().min(0).optional(),
  ownerGid: z.number().int().min(0).optional(),
});

export const stackInitCommandSchema = z.object({
  volumeName: z.string().min(1),
  mountPath: z.string().min(1).regex(/^\/[a-zA-Z0-9_.\/-]*$/, "mountPath must be a safe absolute path"),
  commands: z.array(z.string().min(1)),
});

export const stackServiceRoutingSchema = z.object({
  hostname: z.string().min(1).max(253),
  listeningPort: numberOrTemplate,
  healthCheckEndpoint: z.string().max(500).optional(),
  backendOptions: z
    .object({
      balanceAlgorithm: z.enum(["roundrobin", "leastconn", "source"]).optional(),
      checkTimeout: numberOrTemplateMin0.optional(),
      connectTimeout: numberOrTemplateMin0.optional(),
      serverTimeout: numberOrTemplateMin0.optional(),
    })
    .optional(),
  tlsCertificate: z.string().optional(),
  dnsRecord: z.string().optional(),
  tunnelIngress: z.string().optional(),
});

export const stackResourceOutputSchema = z.object({
  type: z.string().min(1),
  purpose: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  joinSelf: z.boolean().optional(),
});

export const stackResourceInputSchema = z.object({
  type: z.string().min(1),
  purpose: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  optional: z.boolean().optional(),
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

export const stackTlsCertificateSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  fqdn: z.string().min(1).max(253),
});

export const stackDnsRecordSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  fqdn: z.string().min(1).max(253),
  recordType: z.literal('A'),
  target: z.string().min(1),
  ttl: z.number().int().min(60).max(86400).optional(),
  proxied: z.boolean().optional(),
});

export const stackTunnelIngressSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  fqdn: z.string().min(1).max(253),
  service: z.string().min(1),
});

export const adoptedContainerSchema = z.object({
  containerName: z.string().min(1).max(253),
  listeningPort: z.number().int().min(1).max(65535),
});

const nameRegex = /^[a-zA-Z0-9_-]+$/;

const stackNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(nameRegex, "Stack name can only contain letters, numbers, hyphens, and underscores");

export const stackServiceDefinitionSchema = z
  .object({
    serviceName: z
      .string()
      .min(1)
      .max(100)
      .regex(
        nameRegex,
        "Service name can only contain letters, numbers, hyphens, and underscores"
      ),
    serviceType: z.enum(["Stateful", "StatelessWeb", "AdoptedWeb"]),
    dockerImage: z.string().min(1),
    dockerTag: z.string().min(1),
    containerConfig: stackContainerConfigSchema,
    configFiles: z.array(stackConfigFileSchema).optional(),
    initCommands: z.array(stackInitCommandSchema).optional(),
    dependsOn: z.array(z.string()),
    order: z.number().int().min(0),
    routing: stackServiceRoutingSchema.optional(),
    adoptedContainer: adoptedContainerSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.serviceType === "StatelessWeb" && !data.routing) {
        return false;
      }
      return true;
    },
    {
      message: "StatelessWeb services must have routing",
    }
  )
  .refine(
    (data) => {
      if (data.serviceType === "AdoptedWeb" && !data.routing) {
        return false;
      }
      return true;
    },
    {
      message: "AdoptedWeb services must have routing",
    }
  )
  .refine(
    (data) => {
      if (data.serviceType === "AdoptedWeb" && !data.adoptedContainer) {
        return false;
      }
      return true;
    },
    {
      message: "AdoptedWeb services must have adoptedContainer",
    }
  );

// The portable StackDefinition shape (no DB fields)
export const stackDefinitionSchema = z.object({
  name: stackNameSchema,
  description: z.string().max(500).optional(),
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  resourceOutputs: z.array(stackResourceOutputSchema).optional(),
  resourceInputs: z.array(stackResourceInputSchema).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  tlsCertificates: z.array(stackTlsCertificateSchema).optional(),
  dnsRecords: z.array(stackDnsRecordSchema).optional(),
  tunnelIngress: z.array(stackTunnelIngressSchema).optional(),
  services: z.array(stackServiceDefinitionSchema),
});

// API request schemas

export const createStackSchema = z.object({
  name: stackNameSchema,
  description: z.string().max(500).optional(),
  environmentId: z.string().min(1).optional(),
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  parameterValues: parameterValuesSchema.optional(),
  resourceOutputs: z.array(stackResourceOutputSchema).optional(),
  resourceInputs: z.array(stackResourceInputSchema).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  tlsCertificates: z.array(stackTlsCertificateSchema).optional(),
  dnsRecords: z.array(stackDnsRecordSchema).optional(),
  tunnelIngress: z.array(stackTunnelIngressSchema).optional(),
  services: z.array(stackServiceDefinitionSchema),
});

export const updateStackSchema = z.object({
  name: stackNameSchema.optional(),
  description: z.string().max(500).optional(),
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  parameterValues: parameterValuesSchema.optional(),
  resourceOutputs: z.array(stackResourceOutputSchema).optional(),
  resourceInputs: z.array(stackResourceInputSchema).optional(),
  networks: z.array(stackNetworkSchema).optional(),
  volumes: z.array(stackVolumeSchema).optional(),
  tlsCertificates: z.array(stackTlsCertificateSchema).optional(),
  dnsRecords: z.array(stackDnsRecordSchema).optional(),
  tunnelIngress: z.array(stackTunnelIngressSchema).optional(),
  services: z.array(stackServiceDefinitionSchema).optional(),
});

export const updateStackServiceSchema = z.object({
  serviceType: z.enum(["Stateful", "StatelessWeb", "AdoptedWeb"]).optional(),
  dockerImage: z.string().min(1).optional(),
  dockerTag: z.string().min(1).optional(),
  containerConfig: stackContainerConfigSchema.optional(),
  configFiles: z.array(stackConfigFileSchema).optional(),
  initCommands: z.array(stackInitCommandSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
  order: z.number().int().min(0).optional(),
  routing: stackServiceRoutingSchema.nullable().optional(),
  adoptedContainer: adoptedContainerSchema.nullable().optional(),
});

export const applyStackSchema = z.object({
  serviceNames: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
  forcePull: z.boolean().optional(),
});
