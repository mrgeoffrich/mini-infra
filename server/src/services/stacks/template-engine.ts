import {
  EnvironmentNetworkType,
  EnvironmentType,
  StackConfigFile,
  StackContainerConfig,
  StackNetwork,
  StackParameterValue,
  StackServiceDefinition,
  StackVolume,
} from '@mini-infra/types';

export interface TemplateContextStack {
  id?: string;
  name: string;
  projectName: string;
}

export interface TemplateContextEnvironment {
  id: string;
  name: string;
  type: EnvironmentType;
  networkType: EnvironmentNetworkType;
}

export interface TemplateContext {
  stack: TemplateContextStack;
  services: Record<string, { containerName: string; image: string }>;
  /**
   * Static container env vars merged across services. Internal to the engine —
   * not currently reachable via `{{env.*}}` substitution because the schema
   * regex restricts substitution to the `params|stack|environment` namespaces.
   */
  env: Record<string, string>;
  volumes: Record<string, string>;
  networks: Record<string, string>;
  params: Record<string, StackParameterValue>;
  /**
   * Present only for environment-scoped stacks. Host-scoped templates that
   * reference `{{environment.*}}` will fail at apply with an "Unresolved
   * template variable" error from `resolveTemplate`.
   */
  environment?: TemplateContextEnvironment;
}

export interface BuildTemplateContextOptions {
  stackId?: string;
  environment?: TemplateContextEnvironment;
  params?: Record<string, StackParameterValue>;
}

export function buildTemplateContext(
  stack: { name: string; networks: StackNetwork[]; volumes: StackVolume[] },
  services: {
    serviceName: string;
    dockerImage: string;
    dockerTag: string;
    containerConfig: StackContainerConfig;
  }[],
  options: BuildTemplateContextOptions = {}
): TemplateContext {
  const { stackId, environment, params } = options;
  const projectName = environment ? `${environment.name}-${stack.name}` : `mini-infra-${stack.name}`;

  const svcMap: Record<string, { containerName: string; image: string }> = {};
  const envMap: Record<string, string> = {};

  for (const svc of services) {
    svcMap[svc.serviceName] = {
      containerName: `${projectName}-${svc.serviceName}`,
      image: `${svc.dockerImage}:${svc.dockerTag}`,
    };
    if (svc.containerConfig.env) {
      Object.assign(envMap, svc.containerConfig.env);
    }
  }

  const volumeMap: Record<string, string> = {};
  for (const v of stack.volumes) {
    volumeMap[v.name] = `${projectName}_${v.name}`;
  }

  const networkMap: Record<string, string> = {};
  for (const n of stack.networks) {
    networkMap[n.name] = `${projectName}_${n.name}`;
  }

  const ctx: TemplateContext = {
    stack: { name: stack.name, projectName, ...(stackId !== undefined ? { id: stackId } : {}) },
    services: svcMap,
    env: envMap,
    volumes: volumeMap,
    networks: networkMap,
    params: params ?? {},
  };

  if (environment) ctx.environment = environment;

  return ctx;
}

export function resolveTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path: string) => {
    const parts = path.trim().split('.');
    let current: unknown = context;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        throw new Error(`Unresolved template variable: ${match}`);
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current === undefined || current === null) {
      throw new Error(`Unresolved template variable: ${match}`);
    }
    if (typeof current === 'object') {
      throw new Error(`Unresolved template variable: ${match}`);
    }
    return String(current);
  });
}

export function resolveStackConfigFiles(
  configFiles: StackConfigFile[],
  context: TemplateContext
): StackConfigFile[] {
  return configFiles.map((file) => ({
    ...file,
    content: resolveTemplate(file.content, context),
  }));
}

/**
 * Recursively resolve all template strings in an object tree.
 */
function deepResolve(obj: unknown, context: TemplateContext): unknown {
  if (typeof obj === 'string') {
    // Only attempt resolution if the string contains template syntax
    if (obj.includes('{{')) {
      return resolveTemplate(obj, context);
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => deepResolve(item, context));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepResolve(v, context);
    }
    return result;
  }
  return obj;
}

/**
 * Narrow a resolved value to a finite number, throwing a clear error otherwise.
 * After template resolution, any remaining non-numeric content (e.g. an
 * unresolved `{{params.x}}` reference or a typo'd default) would silently
 * coerce to `NaN` and reach Docker/HAProxy as `"NaN"` — this converts that
 * into a loud failure at the boundary instead.
 */
function toFiniteNumber(value: unknown, field: string, serviceName: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `Service "${serviceName}" field "${field}" did not resolve to a finite number (got ${JSON.stringify(value)})`
    );
  }
  return n;
}

function coerceExposeOnHost(value: unknown): boolean {
  // After resolution, a boolean `true` stays boolean; a `{{params.x}}`
  // reference to a boolean param renders as the string "true" or "false".
  return value === true || value === 'true';
}

/**
 * Coerce known numeric fields in a service definition from resolved strings back to numbers.
 * Applied after template resolution.
 */
function coerceServiceDefinitionTypes(def: StackServiceDefinition): StackServiceDefinition {
  const config = def.containerConfig;
  const svcName = def.serviceName;

  if (config.ports) {
    config.ports = config.ports.map((p, idx) => ({
      ...p,
      containerPort: toFiniteNumber(p.containerPort, `ports[${idx}].containerPort`, svcName),
      hostPort: toFiniteNumber(p.hostPort, `ports[${idx}].hostPort`, svcName),
      ...(p.exposeOnHost !== undefined && {
        exposeOnHost: coerceExposeOnHost(p.exposeOnHost),
      }),
    }));
  }

  if (config.healthcheck) {
    config.healthcheck = {
      ...config.healthcheck,
      interval: toFiniteNumber(config.healthcheck.interval, 'healthcheck.interval', svcName),
      timeout: toFiniteNumber(config.healthcheck.timeout, 'healthcheck.timeout', svcName),
      retries: toFiniteNumber(config.healthcheck.retries, 'healthcheck.retries', svcName),
      startPeriod: toFiniteNumber(config.healthcheck.startPeriod, 'healthcheck.startPeriod', svcName),
    };
  }

  if (def.routing) {
    def.routing = {
      ...def.routing,
      listeningPort: toFiniteNumber(def.routing.listeningPort, 'routing.listeningPort', svcName),
    };
    if (def.routing.backendOptions) {
      const bo = def.routing.backendOptions;
      def.routing.backendOptions = {
        ...bo,
        ...(bo.checkTimeout !== undefined && {
          checkTimeout: toFiniteNumber(bo.checkTimeout, 'routing.backendOptions.checkTimeout', svcName),
        }),
        ...(bo.connectTimeout !== undefined && {
          connectTimeout: toFiniteNumber(bo.connectTimeout, 'routing.backendOptions.connectTimeout', svcName),
        }),
        ...(bo.serverTimeout !== undefined && {
          serverTimeout: toFiniteNumber(bo.serverTimeout, 'routing.backendOptions.serverTimeout', svcName),
        }),
      };
    }
  }

  return def;
}

/**
 * Resolve all template strings in a service definition and coerce types.
 * Returns a new object — the original is not modified.
 */
export function resolveServiceDefinition(
  service: StackServiceDefinition,
  context: TemplateContext
): StackServiceDefinition {
  const resolved = deepResolve(service, context) as StackServiceDefinition;
  return coerceServiceDefinitionTypes(resolved);
}
