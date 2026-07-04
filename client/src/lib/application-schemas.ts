import { z } from "zod";
import {
  STACK_SERVICE_TYPES,
  RESTART_POLICIES,
  NETWORK_PROTOCOLS,
  APPLICATIONS_NETWORK_PURPOSE,
  isHaproxyRoutedServiceType,
  type StackResourceInput,
  type StackServiceType,
} from "@mini-infra/types";

/**
 * Network declarations that put an application's container onto the
 * environment's HAProxy `applications` network. HAProxy-routed service types
 * (StatelessWeb / AdoptedWeb) must join it for traffic to flow — returned as
 * both the stack-level resource input (so the purpose resolves to
 * `<environment>-applications` at apply time) and the service-level
 * `joinResourceNetworks` membership. Non-routed types get `undefined` for
 * both. The server enforces the same invariant at apply time; declaring it
 * here keeps the stored definition self-describing across new/edit/adopt.
 */
export function applicationsNetworkDeclaration(serviceType: StackServiceType): {
  resourceInputs: StackResourceInput[] | undefined;
  joinResourceNetworks: string[] | undefined;
} {
  if (!isHaproxyRoutedServiceType(serviceType)) {
    return { resourceInputs: undefined, joinResourceNetworks: undefined };
  }
  return {
    resourceInputs: [{ type: "docker-network", purpose: APPLICATIONS_NETWORK_PURPOSE }],
    joinResourceNetworks: [APPLICATIONS_NETWORK_PURPOSE],
  };
}

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

// Matches the full-hostname format enforced elsewhere for HAProxy routes
// (see client/src/components/haproxy/add-route-dialog.tsx).
const HOSTNAME_REGEX = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Field-level routing validation is intentionally lenient on `hostname` only
// with respect to emptiness: a non-routed service (e.g. Stateful) keeps a
// leftover `routing` object with an empty hostname, and that must not fail
// validation. The "hostname is required when routing is enabled" rule is
// enforced by `requireRoutingHostnameWhenEnabled` on the final create/edit
// schemas, so that error only fires (and only surfaces) when the routing step
// is actually in play. A non-empty hostname must still be a valid DNS name —
// this is what a real Cloudflare DNS record / ACME certificate gets issued
// for, so garbage input here fails silently much further downstream instead.
export const routingSchema = z.object({
  hostname: z
    .string()
    .refine(
      (value) => value.length === 0 || HOSTNAME_REGEX.test(value),
      "Must be a valid hostname (e.g. app.example.com)",
    ),
  listeningPort: z.number().int().min(1).max(65535),
  enableSsl: z.boolean().optional(),
  enableTunnel: z.boolean().optional(),
});

/**
 * A link from this application's container to another container it needs to
 * reach over the Docker network (e.g. a database). The durable, round-tripped
 * unit is the `networkName` (folded into `containerConfig.joinNetworks`). The
 * `containerName` is a best-effort label captured when the user picks a
 * container — it powers the read-only host hint but can't be recovered from
 * `joinNetworks` alone, so it's optional (re-derived from live network
 * membership when an application is re-opened for editing).
 */
export const linkedContainerSchema = z.object({
  containerName: z.string().optional(),
  networkName: z.string().min(1, "Network is required"),
});

export type LinkedContainer = z.infer<typeof linkedContainerSchema>;

export const serviceNameSchema = z
  .string()
  .min(1, "Service name is required")
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/,
    "Must be lowercase, alphanumeric with hyphens, no leading/trailing hyphens",
  );

// ---- Shared config fields (used by both create and edit forms) ----

export const applicationConfigBaseSchema = z.object({
  ports: z.array(portMappingSchema),
  envVars: z.array(envVarSchema),
  volumeMounts: z.array(volumeMountSchema),
  linkedContainers: z.array(linkedContainerSchema),
  enableHealthCheck: z.boolean(),
  healthCheck: healthCheckSchema.optional(),
  restartPolicy: z.enum(RESTART_POLICIES),
});

export type ApplicationConfigData = z.infer<typeof applicationConfigBaseSchema>;

// ---- Shared routing fields ----

export const applicationRoutingBaseSchema = z.object({
  enableRouting: z.boolean(),
  routing: routingSchema.optional(),
});

export type ApplicationRoutingData = z.infer<
  typeof applicationRoutingBaseSchema
>;

/**
 * Require a hostname only when routing is enabled. Applied as a superRefine on
 * the final create/edit schemas (not the mergeable base, which must stay a
 * ZodObject). The issue path targets `routing.hostname` so the RoutingCard's
 * field-level message still renders it.
 */
function requireRoutingHostnameWhenEnabled(
  data: { enableRouting: boolean; routing?: { hostname?: string } },
  ctx: z.RefinementCtx,
): void {
  if (
    data.enableRouting &&
    (!data.routing || data.routing.hostname?.trim().length === 0 || !data.routing.hostname)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["routing", "hostname"],
      message: "Hostname is required",
    });
  }
}

// ---- Create form schema (includes deploy + health check options) ----

export const createApplicationFormSchema = z
  .object({
    displayName: z.string().min(1, "Application name is required").max(100),
    serviceName: serviceNameSchema,
    serviceType: z.enum(STACK_SERVICE_TYPES),
    environmentId: z.string().min(1, "Environment is required"),
    dockerImage: z.string().min(1, "Docker image is required"),
    dockerTag: z.string().min(1, "Tag is required"),
    deployImmediately: z.boolean(),
  })
  .merge(applicationConfigBaseSchema)
  .merge(applicationRoutingBaseSchema)
  .superRefine(requireRoutingHostnameWhenEnabled);

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
  linkedContainers: [],
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

// ---- Edit form schema (no deploy option, adds description + SSL/tunnel) ----

export const editApplicationFormSchema = z
  .object({
    displayName: z.string().min(1, "Application name is required").max(100),
    description: z.string().max(500).optional(),
    serviceName: serviceNameSchema,
    serviceType: z.enum(STACK_SERVICE_TYPES),
    dockerImage: z.string().min(1, "Docker image is required"),
    dockerTag: z.string().min(1, "Tag is required"),
  })
  .merge(applicationConfigBaseSchema)
  .merge(applicationRoutingBaseSchema)
  .superRefine(requireRoutingHostnameWhenEnabled);

export type EditApplicationFormData = z.infer<typeof editApplicationFormSchema>;

export const editApplicationDefaults: EditApplicationFormData = {
  displayName: "",
  description: "",
  serviceName: "",
  serviceType: "Stateful",
  dockerImage: "",
  dockerTag: "latest",
  ports: [],
  envVars: [],
  volumeMounts: [],
  linkedContainers: [],
  enableRouting: false,
  routing: undefined,
  restartPolicy: "unless-stopped",
  enableHealthCheck: false,
  healthCheck: {
    test: "curl -f http://localhost/ || exit 1",
    interval: 30,
    timeout: 10,
    retries: 3,
    startPeriod: 15,
  },
};
