import { createHash } from 'crypto';
import { StackServiceDefinition, StackConfigFile } from '@mini-infra/types';

function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => stableStringify(item)).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableStringify((obj as Record<string, unknown>)[key]));
    return '{' + sorted.join(',') + '}';
  }
  return JSON.stringify(obj);
}

export function computeDefinitionHash(
  service: StackServiceDefinition,
  resolvedConfigFiles?: StackConfigFile[]
): string {
  let canonical: unknown;

  if (service.serviceType === 'AdoptedWeb') {
    // AdoptedWeb services don't manage the container — hash only the adoption ref and routing
    canonical = {
      serviceType: 'AdoptedWeb',
      adoptedContainer: service.adoptedContainer ?? null,
      routing: service.routing ?? null,
    };
  } else {
    const configFiles = resolvedConfigFiles ?? service.configFiles ?? [];
    const sortedConfigFiles = [...configFiles].sort((a, b) =>
      `${a.volumeName}:${a.path}`.localeCompare(`${b.volumeName}:${b.path}`)
    );
    const sortedInitCommands = [...(service.initCommands ?? [])].sort((a, b) =>
      `${a.volumeName}:${a.mountPath}`.localeCompare(`${b.volumeName}:${b.mountPath}`)
    );

    canonical = {
      dockerImage: service.dockerImage,
      dockerTag: service.dockerTag,
      containerConfig: service.containerConfig,
      configFiles: sortedConfigFiles,
      initCommands: sortedInitCommands,
      routing: service.routing ?? null,
    };
  }

  const hash = createHash('sha256')
    .update(stableStringify(canonical))
    .digest('hex');

  return `sha256:${hash}`;
}
