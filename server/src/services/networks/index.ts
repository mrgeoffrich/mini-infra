import DockerService from '../docker';
import type { DockerExecutorService } from '../docker-executor';
import { NetworkManager, type NetworkManagerDeps } from './network-manager';

export * from './network-manager';
export * from './network-names';
export * from './attach-service-networks';
export * from './network-gc';
export * from './membership-store';
export * from './membership-compiler';
export * from './membership-backfill';
export * from './network-reconciler';
export * from './network-converger';
export * from './network-convergence-scheduler';
export * from './managed-network-listing';
export * from './unified-network-declarations';
export * from './applications-membership';

/**
 * Construct a NetworkManager wired to invalidate `DockerService`'s cached
 * network list after every mutation, so `GET /api/docker/networks` doesn't
 * serve stale data for its 3s TTL window after a stack apply/destroy. This
 * is the standard way stack code obtains a NetworkManager — tests (or any
 * caller that doesn't want that side effect) can construct
 * `new NetworkManager(dockerSource)` directly instead.
 */
export function createNetworkManager(
  dockerSource: Pick<DockerExecutorService, 'getDockerClient'>,
): NetworkManager {
  const deps: NetworkManagerDeps = {
    invalidateCache: () => DockerService.getInstance().invalidateNetworksCache(),
  };
  return new NetworkManager(dockerSource, deps);
}
