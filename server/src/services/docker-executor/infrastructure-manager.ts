import Docker from "dockerode";
import { getLogger } from "../../lib/logger-factory";

/**
 * InfrastructureManager - Manages Docker volumes.
 *
 * Network methods (createNetwork/networkExists/removeNetwork) used to live
 * here too, but the network overhaul (docs/designs/docker-network-management-redesign.md)
 * moved every Docker network operation behind `NetworkManager`
 * (`services/networks/network-manager.ts`) — the ONLY place permitted to
 * call Docker's network API (enforced by
 * `server/src/__tests__/network-api-boundary.test.ts`). Volumes have no
 * equivalent consolidation yet, so they stay here.
 */
export class InfrastructureManager {
  private docker: Docker;

  constructor(docker: Docker) {
    this.docker = docker;
  }

  /**
   * Create a Docker volume with compose-style labels
   * Note: volumeName should already be prefixed with environment name
   */
  public async createVolume(
    volumeName: string,
    projectName?: string,
    options?: { labels?: Record<string, string> }
  ): Promise<void> {
    try {
      const existingVolumes = await this.docker.listVolumes();
      const volumeExists = existingVolumes.Volumes?.some(vol => vol.Name === volumeName);

      if (!volumeExists) {
        const labels: Record<string, string> = {
          'mini-infra.managed': 'true',
        };

        if (projectName) {
          labels['com.docker.compose.project'] = projectName;
          labels['com.docker.compose.volume'] = volumeName;
          labels['mini-infra.project'] = projectName;
        }

        if (options?.labels) {
          Object.assign(labels, options.labels);
        }

        await this.docker.createVolume({
          Name: volumeName,
          Labels: labels
        });

        getLogger("docker", "infrastructure-manager").info({ volume: volumeName, project: projectName }, 'Created volume');
      } else {
        getLogger("docker", "infrastructure-manager").info({ volume: volumeName }, 'Volume already exists');
      }
    } catch (error) {
      getLogger("docker", "infrastructure-manager").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volume: volumeName,
          project: projectName,
        },
        "Failed to create volume",
      );
      throw error;
    }
  }

  /**
   * Check if a Docker volume exists
   */
  public async volumeExists(volumeName: string): Promise<boolean> {
    try {
      const volumes = await this.docker.listVolumes();
      return volumes.Volumes?.some(volume => volume.Name === volumeName) || false;
    } catch (error) {
      getLogger("docker", "infrastructure-manager").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to check if volume exists"
      );
      return false;
    }
  }

  /**
   * Remove a Docker volume
   */
  public async removeVolume(volumeName: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(volumeName);
      await volume.remove();
      getLogger("docker", "infrastructure-manager").info({ volumeName }, 'Docker volume removed successfully');
    } catch (error) {
      getLogger("docker", "infrastructure-manager").error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to remove Docker volume"
      );
      throw error;
    }
  }
}
