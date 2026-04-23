import { createHash } from 'crypto';
import { StackServiceDefinition, StackConfigFile, StackContainerConfig } from '@mini-infra/types';

/**
 * Strip apply-time dynamic-env metadata from containerConfig before hashing.
 *
 * Dynamic env values (e.g. vault-wrapped-secret-id) are resolved at apply time
 * and intentionally not part of stack identity — including them in the hash
 * would cause drift false-positives and force spurious recreates.
 */
function stripDynamic(cc: StackContainerConfig | undefined): StackContainerConfig | undefined {
  if (!cc || !cc.dynamicEnv) return cc;
  const { dynamicEnv: _omit, ...rest } = cc;
  void _omit;
  return rest;
}

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
      containerConfig: stripDynamic(service.containerConfig),
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
