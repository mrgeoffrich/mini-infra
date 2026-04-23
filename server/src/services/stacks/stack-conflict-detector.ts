import Docker from 'dockerode';
import type { Logger } from 'pino';
import type { PlanWarning, StackServiceDefinition } from '@mini-infra/types';
import type { StackContainerManager } from './stack-container-manager';

/**
 * Scan host containers for port and name conflicts with this stack's desired services.
 */
export async function detectConflicts(
  resolvedDefinitions: Map<string, StackServiceDefinition>,
  stackId: string,
  projectName: string,
  docker: Docker
): Promise<PlanWarning[]> {
  const warnings: PlanWarning[] = [];

  // List all containers on the host (including stopped for name conflicts)
  const allContainers = await docker.listContainers({ all: true });

  // Partition into "other" containers (not belonging to this stack)
  const otherContainers = allContainers.filter(
    (c) => c.Labels['mini-infra.stack-id'] !== stackId
  );

  // --- Port conflicts (running containers only) ---
  const usedPorts = new Map<string, Docker.ContainerInfo>();
  for (const container of otherContainers) {
    if (container.State !== 'running') continue;
    for (const portInfo of container.Ports ?? []) {
      if (portInfo.PublicPort) {
        usedPorts.set(`${portInfo.PublicPort}/${portInfo.Type}`, container);
      }
    }
  }

  for (const [serviceName, def] of resolvedDefinitions) {
    for (const port of def.containerConfig.ports ?? []) {
      // Skip internal-only ports — they don't bind to host so can't conflict
      if (port.exposeOnHost === false || port.hostPort === 0) continue;

      const key = `${port.hostPort}/${port.protocol}`;
      const conflict = usedPorts.get(key);
      if (!conflict) continue;

      const containerName = conflict.Names?.[0]?.replace(/^\//, '') ?? conflict.Id.slice(0, 12);
      const conflictStackName = conflict.Labels['mini-infra.stack'] || undefined;

      warnings.push({
        type: 'port-conflict',
        serviceName,
        hostPort: Number(port.hostPort),
        protocol: port.protocol,
        conflictingContainerName: containerName,
        conflictingStackName: conflictStackName,
        message: conflictStackName
          ? `Port ${port.hostPort}/${port.protocol} is in use by "${containerName}" (stack: ${conflictStackName})`
          : `Port ${port.hostPort}/${port.protocol} is in use by "${containerName}"`,
      });
    }
  }

  // --- Container name conflicts (all containers, including stopped) ---
  const usedNames = new Map<string, Docker.ContainerInfo>();
  for (const container of otherContainers) {
    for (const name of container.Names ?? []) {
      usedNames.set(name.replace(/^\//, ''), container);
    }
  }

  for (const [serviceName] of resolvedDefinitions) {
    const desiredName = `${projectName}-${serviceName}`;
    const conflict = usedNames.get(desiredName);
    if (!conflict) continue;

    const conflictStackName = conflict.Labels['mini-infra.stack'] || undefined;

    warnings.push({
      type: 'name-conflict',
      serviceName,
      desiredContainerName: desiredName,
      conflictingContainerId: conflict.Id.slice(0, 12),
      conflictingStackName: conflictStackName,
      message: conflictStackName
        ? `Container name "${desiredName}" is taken by a container from stack "${conflictStackName}"`
        : `Container name "${desiredName}" is taken by an existing container (${conflict.Id.slice(0, 12)})`,
    });
  }

  return warnings;
}

/**
 * Remove a container with the same name that belongs to a different stack.
 * Used before create actions to clear stale containers from failed applies.
 */
export async function removeConflictingContainer(
  containerName: string,
  stackId: string,
  docker: Docker,
  containerManager: StackContainerManager,
  log: Logger
): Promise<void> {
  const allContainers = await docker.listContainers({ all: true });
  const conflict = allContainers.find(
    (c) =>
      c.Names?.some((n) => n.replace(/^\//, '') === containerName) &&
      c.Labels['mini-infra.stack-id'] !== stackId
  );
  if (conflict) {
    log.warn(
      { containerName, conflictId: conflict.Id.slice(0, 12) },
      'Removing conflicting container with same name before create'
    );
    await containerManager.stopAndRemoveContainer(conflict.Id);
  }
}
