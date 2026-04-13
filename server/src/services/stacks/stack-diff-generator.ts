import type { FieldDiff, StackDefinition, StackServiceDefinition } from '@mini-infra/types';

export function generateDiffs(
  serviceName: string,
  snapshot: StackDefinition | null,
  current: StackServiceDefinition
): FieldDiff[] {
  if (!snapshot) return [];

  const oldService = snapshot.services.find((s) => s.serviceName === serviceName);
  if (!oldService) return [];

  const diffs: FieldDiff[] = [];

  if (oldService.dockerImage !== current.dockerImage) {
    diffs.push({ field: 'dockerImage', old: oldService.dockerImage, new: current.dockerImage });
  }
  if (oldService.dockerTag !== current.dockerTag) {
    diffs.push({ field: 'dockerTag', old: oldService.dockerTag, new: current.dockerTag });
  }

  const oldConfig = JSON.stringify(oldService.containerConfig);
  const newConfig = JSON.stringify(current.containerConfig);
  if (oldConfig !== newConfig) {
    diffs.push({ field: 'containerConfig', old: oldConfig, new: newConfig });
  }

  const oldFiles = JSON.stringify(oldService.configFiles ?? []);
  const newFiles = JSON.stringify(current.configFiles ?? []);
  if (oldFiles !== newFiles) {
    diffs.push({ field: 'configFiles', old: oldFiles, new: newFiles });
  }

  const oldInit = JSON.stringify(oldService.initCommands ?? []);
  const newInit = JSON.stringify(current.initCommands ?? []);
  if (oldInit !== newInit) {
    diffs.push({ field: 'initCommands', old: oldInit, new: newInit });
  }

  const oldRouting = JSON.stringify(oldService.routing ?? null);
  const newRouting = JSON.stringify(current.routing ?? null);
  if (oldRouting !== newRouting) {
    diffs.push({ field: 'routing', old: oldRouting, new: newRouting });
  }

  return diffs;
}

export function buildReason(
  currentImage: string,
  desiredImage: string,
  diffs: FieldDiff[]
): string {
  if (currentImage !== desiredImage) {
    return `image changed: ${currentImage} -> ${desiredImage}`;
  }
  if (diffs.length > 0) {
    const fields = diffs.map((d) => d.field).join(', ');
    return `configuration changed: ${fields}`;
  }
  return 'definition hash changed';
}
