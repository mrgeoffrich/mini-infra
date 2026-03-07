import {
  StackConfigFile,
  StackContainerConfig,
  StackNetwork,
  StackVolume,
} from '@mini-infra/types';

export interface TemplateContext {
  stack: { name: string; projectName: string };
  services: Record<string, { containerName: string; image: string }>;
  env: Record<string, string>;
  volumes: Record<string, string>;
  networks: Record<string, string>;
}

export function buildTemplateContext(
  stack: { name: string; networks: StackNetwork[]; volumes: StackVolume[] },
  services: {
    serviceName: string;
    dockerImage: string;
    dockerTag: string;
    containerConfig: StackContainerConfig;
  }[],
  environmentName: string
): TemplateContext {
  const projectName = `${environmentName}-${stack.name}`;

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
