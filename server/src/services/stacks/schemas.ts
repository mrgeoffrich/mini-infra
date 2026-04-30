import { z } from "zod";
import {
  STACK_SERVICE_TYPES,
  RESTART_POLICIES,
  BALANCE_ALGORITHMS,
  NETWORK_PROTOCOLS,
  MOUNT_TYPES,
  isValidEgressPattern,
} from '@mini-infra/types';
// Note: isValidEgressPattern uses EGRESS_FQDN_RE + EGRESS_WILDCARD_RE from
// lib/types/egress.ts. The egress route (server/src/routes/egress.ts) has
// equivalent inline copies (FQDN_RE / WILDCARD_RE) that predate this constant;
// both are intentionally tied by a comment in lib/types/egress.ts.

// Template string pattern: allows a single, complete {{params.key-name}} reference.
// Anchored so concatenation like "80; {{params.x}}" or "{{params.a}}{{params.b}}"
// is rejected — anything else would flow into Number()/Docker/HAProxy as NaN
// or leak references to non-params scopes via the global replace in template-engine.ts.
const templateStringPattern = /^\{\{params\.[a-zA-Z0-9_-]+\}\}$/;

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

// KV path/field shape mirrors VaultKVService validation (vault-kv-service.ts).
// Kept narrow so the schema rejects malformed entries before they reach the
// resolver — Vault KV v2 paths don't allow leading '/' or '..', and field
// names must be simple identifiers because they're injected as env keys'
// values.
const kvPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_/-]+$/, "vault-kv path may only contain letters, numbers, '_', '-', '/'")
  .refine((p) => !p.startsWith("/") && !p.endsWith("/") && !p.includes("..") && !p.includes("//"), {
    message: "vault-kv path must not start/end with '/' or contain '..' or '//'",
  });

const dynamicEnvSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("vault-addr") }),
  z.object({ kind: z.literal("vault-role-id") }),
  z.object({
    kind: z.literal("vault-wrapped-secret-id"),
    ttlSeconds: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("pool-management-token"),
    poolService: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  }),
  z.object({ kind: z.literal("nats-url") }),
  z.object({ kind: z.literal("nats-creds") }),
  z.object({
    kind: z.literal("vault-kv"),
    path: kvPathSchema,
    field: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, "vault-kv field may only contain letters, numbers, '_', '-'"),
  }),
]);

export const poolConfigSchema = z.object({
  defaultIdleTimeoutMinutes: z.number().int().min(1).max(24 * 60),
  maxInstances: z.number().int().min(1).nullable(),
  managedBy: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).nullable(),
});

export const stackContainerConfigSchema = z.object({
  command: z.array(z.string()).optional(),
  entrypoint: z.array(z.string()).optional(),
  capAdd: z.array(z.string()).optional(),
  user: z.string().optional(),
  egressBypass: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  dynamicEnv: z.record(z.string(), dynamicEnvSourceSchema).optional(),
  ports: z
    .array(
      z.object({
        containerPort: numberOrTemplate,
        // hostPort 0 is valid: it means no host binding (internal-only exposure).
        // The container-manager already treats 0 this way.
        hostPort: numberOrTemplateMin0,
        protocol: z.enum(NETWORK_PROTOCOLS),
        exposeOnHost: booleanOrTemplate.optional(),
      })
    )
    .optional(),
  mounts: z
    .array(
      z.object({
        source: z.string().min(1),
        target: z.string().min(1),
        type: z.enum(MOUNT_TYPES),
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
    .enum(RESTART_POLICIES)
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
  requiredEgress: z
    .array(
      z.string().refine(
        (v) => isValidEgressPattern(v),
        {
          message:
            'requiredEgress entry must be a valid FQDN (e.g. api.example.com) or wildcard (e.g. *.example.com)',
        },
      ),
    )
    .optional(),
}).superRefine((config, ctx) => {
  if (config.env && config.dynamicEnv) {
    const overlap = Object.keys(config.env).filter((k) => k in config.dynamicEnv!);
    if (overlap.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["dynamicEnv"],
        message: `env and dynamicEnv share key(s): ${overlap.join(", ")}. Dynamic keys must be disjoint from static env.`,
      });
    }
  }

  // Single-use credentials must not be paired with a restart policy that
  // retries forever. A wrapped secret_id is consumed by the unwrap call on
  // first boot; subsequent restarts spam "wrapping token is not valid",
  // which buries the original first-boot error (e.g. invalid Slack token).
  // For these services, restartPolicy must be 'no' or 'on-failure' so the
  // operator sees the real failure and can redeploy to mint a fresh token.
  if (config.dynamicEnv && (config.restartPolicy === 'always' || config.restartPolicy === 'unless-stopped')) {
    const wrappedKeys = Object.entries(config.dynamicEnv)
      .filter(([, src]) => src.kind === 'vault-wrapped-secret-id')
      .map(([k]) => k);
    if (wrappedKeys.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["restartPolicy"],
        message:
          `restartPolicy="${config.restartPolicy}" cannot be combined with vault-wrapped-secret-id (${wrappedKeys.join(', ')}). ` +
          `Wrapped secret IDs are single-use; auto-restart will retry the unwrap forever and bury the original first-boot error. ` +
          `Use restartPolicy="no" (preferred) or "on-failure" so the original failure stays visible — redeploy the stack to mint a fresh wrapped token.`,
      });
    }
  }
});

export const stackConfigFileSchema = z.object({
  volumeName: z.string().min(1),
  path: z.string().min(1).regex(/^[a-zA-Z0-9_./-]+$/, "path must contain only safe characters"),
  content: z.string(),
  permissions: z.string().regex(/^[0-7]{3,4}$/, "permissions must be a 3 or 4 digit octal value").optional(),
  ownerUid: z.number().int().min(0).optional(),
  ownerGid: z.number().int().min(0).optional(),
});

export const stackInitCommandSchema = z.object({
  volumeName: z.string().min(1),
  mountPath: z.string().min(1).regex(/^\/[a-zA-Z0-9_./-]*$/, "mountPath must be a safe absolute path"),
  commands: z.array(z.string().min(1)),
});

export const stackServiceRoutingSchema = z.object({
  hostname: z.string().min(1).max(253),
  listeningPort: numberOrTemplate,
  healthCheckEndpoint: z.string().max(500).optional(),
  backendOptions: z
    .object({
      balanceAlgorithm: z.enum(BALANCE_ALGORITHMS).optional(),
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

/**
 * Shared field set for "a service" — common to both the HTTP/DB shape
 * (`stackServiceDefinitionSchema` below) and the file-loaded template shape
 * (`templateServiceSchema` in `template-file-loader.ts`). Each leaf schema
 * extends this with its own additions and applies its own `.refine()`s.
 *
 * Why a shared base: previously these two schemas were independent
 * `z.object({...})` literals. They drifted (vaultAppRoleRef was added to the
 * file loader but not the HTTP schema), and Zod's strip-unknown-keys default
 * made the gap silent — POST /draft would parse successfully but lose the
 * field before it reached Prisma, and apply-time bound nothing. Customer
 * feedback #1 from the slackbot installer review.
 *
 * Adding a new common field here makes it appear in BOTH schemas with no
 * further work, which is the structural property the bug needed. If a field
 * is intentionally specific to one shape (e.g. `configFiles` is only the
 * resolved/embedded form, `vaultAppRoleId` is only set after apply), keep
 * it on the leaf schema's `.extend({...})`.
 *
 * Pure ZodObject (no refines) so leaves can `.extend()` and then `.refine()`
 * without losing extensibility.
 */
export const stackServiceCommonFieldsSchema = z.object({
  serviceName: z
    .string()
    .min(1)
    .max(100)
    .regex(
      nameRegex,
      "Service name can only contain letters, numbers, hyphens, and underscores"
    ),
  serviceType: z.enum(STACK_SERVICE_TYPES),
  dockerImage: z.string().min(1),
  dockerTag: z.string().min(1),
  containerConfig: stackContainerConfigSchema,
  initCommands: z.array(stackInitCommandSchema).optional(),
  dependsOn: z.array(z.string()),
  order: z.number().int().min(0),
  routing: stackServiceRoutingSchema.optional(),
  // Symbolic reference to a vault.appRoles[].name declared in the same draft
  // / template. Resolved to a concrete vaultAppRoleId at apply time.
  vaultAppRoleRef: z.string().min(1).optional(),
  // Symbolic reference to a nats.credentials[].name declared in the same draft
  // / template. Resolved to a concrete natsCredentialId at apply time.
  natsCredentialRef: z.string().min(1).optional(),
});

export const stackServiceDefinitionSchema = stackServiceCommonFieldsSchema
  .extend({
    // Resolved-only fields (post-loader / post-apply): these don't appear in
    // the file-loaded template shape because they are either materialised by
    // the loader (configFiles) or set at apply time (vaultAppRoleId).
    configFiles: z.array(stackConfigFileSchema).optional(),
    adoptedContainer: adoptedContainerSchema.optional(),
    poolConfig: poolConfigSchema.optional(),
    // Resolved concrete IDs — set at apply time only, never present in
    // template/draft input. Symbolic *Ref siblings live on the common base.
    vaultAppRoleId: z.string().min(1).nullable().optional(),
    natsCredentialId: z.string().min(1).nullable().optional(),
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
  )
  .refine(
    (data) => {
      if (data.serviceType === "Pool" && !data.poolConfig) {
        return false;
      }
      return true;
    },
    {
      message: "Pool services must have poolConfig",
    }
  )
  .refine(
    (data) => {
      if (data.serviceType === "Pool" && data.routing) {
        return false;
      }
      return true;
    },
    {
      message: "Pool services cannot have routing",
    }
  );

// Stack-level refinement: cross-service constraints for Pool services.
// - `poolConfig.managedBy` must reference a service in the same stack.
// - Every `pool-management-token` dynamicEnv kind must name an existing Pool service.
function refineCrossServicePoolRefs<
  T extends { services: Array<z.infer<typeof stackServiceDefinitionSchema>> }
>(data: T, ctx: z.RefinementCtx): void {
  const servicesByName = new Map(data.services.map((s) => [s.serviceName, s]));
  for (let i = 0; i < data.services.length; i++) {
    const svc = data.services[i];
    if (svc.serviceType === 'Pool' && svc.poolConfig?.managedBy) {
      if (!servicesByName.has(svc.poolConfig.managedBy)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', i, 'poolConfig', 'managedBy'],
          message: `managedBy references unknown service "${svc.poolConfig.managedBy}"`,
        });
      }
    }
    const dyn = svc.containerConfig?.dynamicEnv;
    if (!dyn) continue;
    for (const [envKey, source] of Object.entries(dyn)) {
      if (source.kind !== 'pool-management-token') continue;
      const target = servicesByName.get(source.poolService);
      if (!target) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', i, 'containerConfig', 'dynamicEnv', envKey, 'poolService'],
          message: `pool-management-token references unknown service "${source.poolService}"`,
        });
        continue;
      }
      if (target.serviceType !== 'Pool') {
        ctx.addIssue({
          code: 'custom',
          path: ['services', i, 'containerConfig', 'dynamicEnv', envKey, 'poolService'],
          message: `pool-management-token must reference a Pool service; "${source.poolService}" is ${target.serviceType}`,
        });
      }
    }
  }
}

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
}).superRefine(refineCrossServicePoolRefs);

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
  // Vault binding — accepted on create so callers don't have to follow up with
  // a PUT just to attach a Vault AppRole before the first apply.
  vaultAppRoleId: z.string().nullable().optional(),
  vaultFailClosed: z.boolean().optional(),
}).superRefine(refineCrossServicePoolRefs);

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
  // Vault binding (Phase 3)
  vaultAppRoleId: z.string().nullable().optional(),
  vaultFailClosed: z.boolean().optional(),
  // Phase 2 — operator-supplied input values (encrypted at rest).
  inputValues: z.record(z.string(), z.string()).optional(),
}).superRefine((data, ctx) => {
  if (data.services) refineCrossServicePoolRefs({ services: data.services }, ctx);
});

export const updateStackServiceSchema = z.object({
  serviceType: z.enum(STACK_SERVICE_TYPES).optional(),
  dockerImage: z.string().min(1).optional(),
  dockerTag: z.string().min(1).optional(),
  containerConfig: stackContainerConfigSchema.optional(),
  configFiles: z.array(stackConfigFileSchema).optional(),
  initCommands: z.array(stackInitCommandSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
  order: z.number().int().min(0).optional(),
  routing: stackServiceRoutingSchema.nullable().optional(),
  adoptedContainer: adoptedContainerSchema.nullable().optional(),
  poolConfig: poolConfigSchema.nullable().optional(),
  vaultAppRoleId: z.string().nullable().optional(),
  natsCredentialId: z.string().nullable().optional(),
});

export const applyStackSchema = z.object({
  serviceNames: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
  forcePull: z.boolean().optional(),
});
