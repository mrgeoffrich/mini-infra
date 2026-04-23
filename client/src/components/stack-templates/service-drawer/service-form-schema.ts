import { z } from "zod";
import {
  STACK_SERVICE_TYPES,
  RESTART_POLICIES,
  BALANCE_ALGORITHMS,
  MOUNT_TYPES,
} from "@mini-infra/types";
import type {
  StackServiceDefinition,
  StackServiceRouting,
  StackContainerConfig,
} from "@mini-infra/types";
import {
  arrayToRecord,
  commandToString,
  compactContainerConfig,
  normalizeInitCommands,
  parseNumberOrTemplate,
  recordToArray,
  stringifyNumberOrTemplate,
  stringToCommand,
} from "./form-utils";

// ---------------------------------------------------------------------------
// Form schema — the shape the UI edits. Submit translates this into a
// StackServiceDefinition (backend-facing).
// ---------------------------------------------------------------------------

const serviceNameRegex = /^[a-z0-9][a-z0-9-]*$/;

// A text field that will be parsed as either an integer or a {{params.*}} ref.
const numOrTemplateString = z
  .string()
  .refine((v) => parseNumberOrTemplate(v, { allowEmpty: true }).ok, {
    message: "Must be an integer or a {{params.name}} reference",
  });

const requiredNumOrTemplateString = z
  .string()
  .refine((v) => parseNumberOrTemplate(v).ok, {
    message: "Must be an integer or a {{params.name}} reference",
  });

export const serviceFormSchema = z.object({
  serviceName: z
    .string()
    .min(1, "Service name is required")
    .regex(
      serviceNameRegex,
      "Lowercase letters, digits, or hyphens; must start with a letter or digit",
    ),
  serviceType: z.enum(STACK_SERVICE_TYPES),
  dockerImage: z.string().min(1, "Docker image is required"),
  dockerTag: z.string().min(1, "Docker tag is required"),
  order: z.coerce.number().int().min(0),
  dependsOn: z.string(), // comma-separated

  // General / container basics
  user: z.string().optional(),
  command: z.string().optional(),
  entrypoint: z.string().optional(),
  restartPolicy: z.enum(RESTART_POLICIES),

  // Environment
  envVars: z.array(z.object({ key: z.string(), value: z.string() })),

  // Ports
  ports: z.array(
    z.object({
      hostPort: requiredNumOrTemplateString,
      containerPort: requiredNumOrTemplateString,
      protocol: z.enum(["tcp", "udp"]),
      // Accept template-string values so the drawer doesn't clobber
      // `{{params.*}}` references on save. The UI renders a disabled Switch
      // with a hint when the value is a string.
      exposeOnHost: z.union([z.boolean(), z.string()]),
    }),
  ),

  // Mounts
  mounts: z.array(
    z.object({
      source: z.string().min(1, "Source required"),
      target: z.string().min(1, "Target required"),
      type: z.enum(MOUNT_TYPES),
      readOnly: z.boolean(),
    }),
  ),

  // Networks
  joinNetworks: z.string(), // comma-separated
  joinResourceNetworks: z.string(), // comma-separated

  // Healthcheck
  healthcheckEnabled: z.boolean(),
  healthcheckTest: z.string(), // space-separated
  healthcheckInterval: numOrTemplateString,
  healthcheckTimeout: numOrTemplateString,
  healthcheckRetries: numOrTemplateString,
  healthcheckStartPeriod: numOrTemplateString,

  // Logging
  loggingEnabled: z.boolean(),
  logType: z.string(),
  logMaxSize: z.string(),
  logMaxFile: z.string(),

  // Labels
  labels: z.array(z.object({ key: z.string(), value: z.string() })),

  // Routing (StatelessWeb/AdoptedWeb only)
  routingHostname: z.string(),
  routingListeningPort: numOrTemplateString,
  routingHealthCheckEndpoint: z.string(),
  routingTlsCertificate: z.string(),
  routingDnsRecord: z.string(),
  routingTunnelIngress: z.string(),
  routingBalanceAlgorithm: z.string(), // "" | balance algorithm
  routingCheckTimeout: numOrTemplateString,
  routingConnectTimeout: numOrTemplateString,
  routingServerTimeout: numOrTemplateString,

  // AdoptedWeb
  adoptedContainerName: z.string(),
  // Adopted listening port is always a literal integer (the adoptedContainer
  // type doesn't support template refs). Validate at form level so invalid
  // input is rejected rather than silently coerced to 0 via `Number(...) || 0`.
  adoptedListeningPort: z
    .string()
    .refine(
      (v) => v === "" || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535),
      "Must be an integer between 1 and 65535",
    ),

  // Init commands
  initCommands: z.array(
    z.object({
      volumeName: z.string(),
      mountPath: z.string(),
      commands: z.string(), // newline-separated
    }),
  ),
});

export type ServiceFormValues = z.infer<typeof serviceFormSchema>;

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

export const emptyFormValues: ServiceFormValues = {
  serviceName: "",
  serviceType: "StatelessWeb",
  dockerImage: "",
  dockerTag: "latest",
  order: 1,
  dependsOn: "",
  user: "",
  command: "",
  entrypoint: "",
  restartPolicy: "unless-stopped",
  envVars: [],
  ports: [],
  mounts: [],
  joinNetworks: "",
  joinResourceNetworks: "",
  healthcheckEnabled: false,
  healthcheckTest: "",
  healthcheckInterval: "30000",
  healthcheckTimeout: "10000",
  healthcheckRetries: "3",
  healthcheckStartPeriod: "0",
  loggingEnabled: false,
  logType: "json-file",
  logMaxSize: "10m",
  logMaxFile: "3",
  labels: [],
  routingHostname: "",
  routingListeningPort: "",
  routingHealthCheckEndpoint: "",
  routingTlsCertificate: "",
  routingDnsRecord: "",
  routingTunnelIngress: "",
  routingBalanceAlgorithm: "",
  routingCheckTimeout: "",
  routingConnectTimeout: "",
  routingServerTimeout: "",
  adoptedContainerName: "",
  adoptedListeningPort: "",
  initCommands: [],
};

// ---------------------------------------------------------------------------
// Translation: StackServiceDefinition -> ServiceFormValues
// ---------------------------------------------------------------------------

export function serviceToFormValues(
  svc: StackServiceDefinition,
): ServiceFormValues {
  const c = svc.containerConfig;
  const r = svc.routing;
  const adopted = svc.adoptedContainer;
  return {
    serviceName: svc.serviceName,
    serviceType: svc.serviceType,
    dockerImage: svc.dockerImage,
    dockerTag: svc.dockerTag,
    order: svc.order,
    dependsOn: svc.dependsOn.join(", "),

    user: c.user ?? "",
    command: commandToString(c.command),
    entrypoint: commandToString(c.entrypoint),
    restartPolicy: c.restartPolicy ?? "unless-stopped",

    envVars: recordToArray(c.env),

    ports: (c.ports ?? []).map((p) => ({
      hostPort: stringifyNumberOrTemplate(p.hostPort),
      containerPort: stringifyNumberOrTemplate(p.containerPort),
      protocol: p.protocol,
      // Pass through boolean values as-is, and preserve template-string
      // references verbatim so they aren't silently rewritten to `true` on
      // save. The UI disables the switch for template-string values; the user
      // must edit them via the YAML code view.
      exposeOnHost: p.exposeOnHost ?? true,
    })),

    mounts: (c.mounts ?? []).map((m) => ({
      source: m.source,
      target: m.target,
      type: m.type,
      readOnly: m.readOnly ?? false,
    })),

    joinNetworks: (c.joinNetworks ?? []).join(", "),
    joinResourceNetworks: (c.joinResourceNetworks ?? []).join(", "),

    healthcheckEnabled: Boolean(c.healthcheck),
    healthcheckTest: c.healthcheck?.test.join(" ") ?? "",
    healthcheckInterval: stringifyNumberOrTemplate(c.healthcheck?.interval ?? 30000),
    healthcheckTimeout: stringifyNumberOrTemplate(c.healthcheck?.timeout ?? 10000),
    healthcheckRetries: stringifyNumberOrTemplate(c.healthcheck?.retries ?? 3),
    healthcheckStartPeriod: stringifyNumberOrTemplate(c.healthcheck?.startPeriod ?? 0),

    loggingEnabled: Boolean(c.logConfig),
    logType: c.logConfig?.type ?? "json-file",
    logMaxSize: c.logConfig?.maxSize ?? "10m",
    logMaxFile: c.logConfig?.maxFile ?? "3",

    labels: recordToArray(c.labels),

    routingHostname: r?.hostname ?? "",
    routingListeningPort: stringifyNumberOrTemplate(r?.listeningPort),
    routingHealthCheckEndpoint: r?.healthCheckEndpoint ?? "",
    routingTlsCertificate: r?.tlsCertificate ?? "",
    routingDnsRecord: r?.dnsRecord ?? "",
    routingTunnelIngress: r?.tunnelIngress ?? "",
    routingBalanceAlgorithm: r?.backendOptions?.balanceAlgorithm ?? "",
    routingCheckTimeout: stringifyNumberOrTemplate(r?.backendOptions?.checkTimeout),
    routingConnectTimeout: stringifyNumberOrTemplate(r?.backendOptions?.connectTimeout),
    routingServerTimeout: stringifyNumberOrTemplate(r?.backendOptions?.serverTimeout),

    adoptedContainerName: adopted?.containerName ?? "",
    adoptedListeningPort:
      adopted?.listeningPort !== undefined ? String(adopted.listeningPort) : "",

    initCommands: (svc.initCommands ?? []).map((ic) => ({
      volumeName: ic.volumeName,
      mountPath: ic.mountPath,
      commands: ic.commands.join("\n"),
    })),
  };
}

// ---------------------------------------------------------------------------
// Translation: ServiceFormValues -> StackServiceDefinition
// ---------------------------------------------------------------------------

function parseOrThrow(
  v: string,
  field: string,
  allowEmpty = false,
): number | string | undefined {
  const res = parseNumberOrTemplate(v, { allowEmpty });
  if (!res.ok) throw new Error(`${field}: ${res.error}`);
  return res.value;
}

function splitCsv(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function formValuesToService(
  values: ServiceFormValues,
): StackServiceDefinition {
  const container: StackContainerConfig = {
    command: stringToCommand(values.command ?? ""),
    entrypoint: stringToCommand(values.entrypoint ?? ""),
    user: values.user?.trim() || undefined,
    restartPolicy: values.restartPolicy,
    env:
      values.envVars.length > 0 ? arrayToRecord(values.envVars) : undefined,
    labels: values.labels.length > 0 ? arrayToRecord(values.labels) : undefined,
    joinNetworks: splitCsv(values.joinNetworks),
    joinResourceNetworks: splitCsv(values.joinResourceNetworks),
    ports: values.ports.map((p) => ({
      hostPort: parseOrThrow(p.hostPort, "Host port") as number | string,
      containerPort: parseOrThrow(p.containerPort, "Container port") as number | string,
      protocol: p.protocol,
      exposeOnHost: p.exposeOnHost,
    })),
    mounts: values.mounts.map((m) => ({
      source: m.source.trim(),
      target: m.target.trim(),
      type: m.type,
      readOnly: m.readOnly,
    })),
  };

  if (values.healthcheckEnabled) {
    const test = values.healthcheckTest.trim();
    if (test) {
      container.healthcheck = {
        test: test.split(/\s+/),
        interval: parseOrThrow(values.healthcheckInterval, "Healthcheck interval") as
          | number
          | string,
        timeout: parseOrThrow(values.healthcheckTimeout, "Healthcheck timeout") as
          | number
          | string,
        retries: parseOrThrow(values.healthcheckRetries, "Healthcheck retries") as
          | number
          | string,
        startPeriod: parseOrThrow(
          values.healthcheckStartPeriod,
          "Healthcheck start period",
        ) as number | string,
      };
    }
  }

  if (values.loggingEnabled && values.logType.trim()) {
    container.logConfig = {
      type: values.logType.trim(),
      maxSize: values.logMaxSize.trim(),
      maxFile: values.logMaxFile.trim(),
    };
  }

  const compactContainer = compactContainerConfig(container);

  // Routing
  let routing: StackServiceRouting | undefined;
  const needsRouting =
    values.serviceType === "StatelessWeb" || values.serviceType === "AdoptedWeb";
  if (needsRouting && values.routingHostname.trim()) {
    routing = {
      hostname: values.routingHostname.trim(),
      listeningPort: parseOrThrow(values.routingListeningPort, "Listening port") as
        | number
        | string,
    };
    if (values.routingHealthCheckEndpoint.trim()) {
      routing.healthCheckEndpoint = values.routingHealthCheckEndpoint.trim();
    }
    if (values.routingTlsCertificate.trim()) {
      routing.tlsCertificate = values.routingTlsCertificate.trim();
    }
    if (values.routingDnsRecord.trim()) {
      routing.dnsRecord = values.routingDnsRecord.trim();
    }
    if (values.routingTunnelIngress.trim()) {
      routing.tunnelIngress = values.routingTunnelIngress.trim();
    }
    const backendOptions: StackServiceRouting["backendOptions"] = {};
    if (values.routingBalanceAlgorithm) {
      backendOptions.balanceAlgorithm = values.routingBalanceAlgorithm as
        (typeof BALANCE_ALGORITHMS)[number];
    }
    const ct = parseOrThrow(values.routingCheckTimeout, "Check timeout", true);
    if (ct !== undefined) backendOptions.checkTimeout = ct as number | string;
    const cct = parseOrThrow(values.routingConnectTimeout, "Connect timeout", true);
    if (cct !== undefined) backendOptions.connectTimeout = cct as number | string;
    const st = parseOrThrow(values.routingServerTimeout, "Server timeout", true);
    if (st !== undefined) backendOptions.serverTimeout = st as number | string;
    if (Object.keys(backendOptions).length > 0) {
      routing.backendOptions = backendOptions;
    }
  }

  // AdoptedWeb
  const adoptedContainer =
    values.serviceType === "AdoptedWeb" && values.adoptedContainerName.trim()
      ? {
          containerName: values.adoptedContainerName.trim(),
          // Zod already enforced integer-in-range; parseInt is a narrowing cast.
          listeningPort: parseInt(values.adoptedListeningPort, 10),
        }
      : undefined;

  const initCommands = normalizeInitCommands(
    values.initCommands.map((ic) => ({
      volumeName: ic.volumeName.trim(),
      mountPath: ic.mountPath.trim(),
      commands: ic.commands.split("\n").map((s) => s.trim()).filter(Boolean),
    })),
  );

  return {
    serviceName: values.serviceName,
    serviceType: values.serviceType,
    dockerImage: values.dockerImage,
    dockerTag: values.dockerTag,
    order: values.order,
    dependsOn: splitCsv(values.dependsOn),
    containerConfig: compactContainer,
    routing,
    adoptedContainer,
    initCommands,
  };
}
