import type { DeploymentVolume } from '@mini-infra/types';

/** A stack service mount as declared in `containerConfig.mounts`. */
export interface StackMount {
  source: string;
  target: string;
  type: string;
  readOnly?: boolean;
}

/**
 * Resolve a stack service mount's Docker source name. Named volumes get the
 * `${projectName}_` prefix — matching how the reconciler creates stack-owned
 * volumes (`stack-reconciler.ts`: `${projectName}_${vol.name}`) — while bind
 * mounts (absolute host paths, which contain a `/`) pass through unchanged.
 *
 * Shared by the Stateful container path (`stack-container-manager`) and the
 * blue-green/StatelessWeb deploy context (`stack-state-machine-context`) so the
 * two never drift on how a declared mount maps to a real Docker volume name.
 */
export function resolveStackMountSource(
  mount: Pick<StackMount, 'source' | 'type'>,
  projectName: string,
): string {
  return mount.type === 'volume' && !mount.source.includes('/')
    ? `${projectName}_${mount.source}`
    : mount.source;
}

/**
 * Map a stack service's declared mounts to the flat `DeploymentVolume[]` the
 * blue-green deploy pipeline consumes. `preResolved: true` marks the source as
 * a final Docker volume name so the deploy path does not re-apply its own
 * environment-name prefix (see `container-lifecycle-manager.buildVolumeBindings`).
 */
export function mountsToDeploymentVolumes(
  mounts: StackMount[] | undefined,
  projectName: string,
): DeploymentVolume[] {
  return (mounts ?? []).map((m) => ({
    hostPath: resolveStackMountSource(m, projectName),
    containerPath: m.target,
    mode: m.readOnly ? 'ro' : 'rw',
    preResolved: true,
  }));
}
