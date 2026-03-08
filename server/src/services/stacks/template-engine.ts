import {
  StackConfigFile,
  StackContainerConfig,
  StackNetwork,
  StackParameterValue,
  StackServiceDefinition,
  StackVolume,
} from '@mini-infra/types';

export interface TemplateContext {
  stack: { name: string; projectName: string };
  services: Record<string, { containerName: string; image: string }>;
  env: Record<string, string>;
  volumes: Record<string, string>;
  networks: Record<string, string>;
  params: Record<string, StackParameterValue>;
}

export function buildTemplateContext(
  stack: { name: string; networks: StackNetwork[]; volumes: StackVolume[] },
  services: {
    serviceName: string;
    dockerImage: string;
    dockerTag: string;
    containerConfig: StackContainerConfig;
  }[],
  environmentName?: string,
  params?: Record<string, StackParameterValue>
): TemplateContext {
  const projectName = environmentName ? `${environmentName}-${stack.name}` : stack.name;

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
    volumeMap[v.name] = `${projectName}-${v.name}`;
  }

  const networkMap: Record<string, string> = {};
  for (const n of stack.networks) {
    networkMap[n.name] = `${projectName}-${n.name}`;
  }

  return {
    stack: { name: stack.name, projectName },
    services: svcMap,
    env: envMap,
    volumes: volumeMap,
    networks: networkMap,
    params: params ?? {},
  };
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
 * Coerce known numeric fields in a service definition from resolved strings back to numbers.
 * Applied after template resolution.
 */
function coerceServiceDefinitionTypes(def: StackServiceDefinition): StackServiceDefinition {
  const config = def.containerConfig;

  if (config.ports) {
    config.ports = config.ports.map((p) => ({
      ...p,
      containerPort: Number(p.containerPort),
      hostPort: Number(p.hostPort),
    }));
  }

  if (config.healthcheck) {
    config.healthcheck = {
      ...config.healthcheck,
      interval: Number(config.healthcheck.interval),
      timeout: Number(config.healthcheck.timeout),
      retries: Number(config.healthcheck.retries),
      startPeriod: Number(config.healthcheck.startPeriod),
    };
  }

  if (def.routing) {
    def.routing = {
      ...def.routing,
      listeningPort: Number(def.routing.listeningPort),
    };
    if (def.routing.backendOptions) {
      const bo = def.routing.backendOptions;
      def.routing.backendOptions = {
        ...bo,
        ...(bo.checkTimeout !== undefined && { checkTimeout: Number(bo.checkTimeout) }),
        ...(bo.connectTimeout !== undefined && { connectTimeout: Number(bo.connectTimeout) }),
        ...(bo.serverTimeout !== undefined && { serverTimeout: Number(bo.serverTimeout) }),
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
