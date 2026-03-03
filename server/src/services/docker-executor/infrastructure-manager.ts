import Docker from "dockerode";
import { servicesLogger } from "../../lib/logger-factory";

/**
 * InfrastructureManager - Manages Docker networks and volumes
 */
export class InfrastructureManager {
  private docker: Docker;

  constructor(docker: Docker) {
    this.docker = docker;
  }

  /**
   * Create a Docker network with compose-style labels
   * Note: networkName should already be prefixed with environment name
   */
  public async createNetwork(
    networkName: string,
    projectName?: string,
    options?: { driver?: string; labels?: Record<string, string> }
  ): Promise<void> {
    try {
      const networks = await this.docker.listNetworks();
      const existingNetwork = networks.find(net => net.Name === networkName);

      if (!existingNetwork) {
        const labels: Record<string, string> = {
          'mini-infra.managed': 'true',
        };

        if (projectName) {
          labels['com.docker.compose.project'] = projectName;
          labels['com.docker.compose.network'] = networkName;
          labels['mini-infra.project'] = projectName;
        }

        if (options?.labels) {
          Object.assign(labels, options.labels);
        }

        await this.docker.createNetwork({
          Name: networkName,
          Driver: options?.driver || 'bridge',
          Labels: labels
        });

        servicesLogger().info({ network: networkName, project: projectName }, 'Created network');
      } else {
        servicesLogger().info({ network: networkName }, 'Network already exists');
      }
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          network: networkName,
          project: projectName,
        },
        "Failed to create network",
      );
      throw error;
    }
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

        servicesLogger().info({ volume: volumeName, project: projectName }, 'Created volume');
      } else {
        servicesLogger().info({ volume: volumeName }, 'Volume already exists');
      }
    } catch (error) {
      servicesLogger().error(
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
   * Check if a Docker network exists
   */
  public async networkExists(networkName: string): Promise<boolean> {
    try {
      const networks = await this.docker.listNetworks();
      return networks.some(network => network.Name === networkName);
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          networkName,
        },
        "Failed to check if network exists"
      );
      return false;
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
      servicesLogger().error(
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
      servicesLogger().info({ volumeName }, 'Docker volume removed successfully');
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to remove Docker volume"
      );
      throw error;
    }
  }

  /**
   * Remove a Docker network
   */
  public async removeNetwork(networkName: string): Promise<void> {
    try {
      const network = this.docker.getNetwork(networkName);
      await network.remove();
      servicesLogger().info({ networkName }, 'Docker network removed successfully');
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          networkName,
        },
        "Failed to remove Docker network"
      );
      throw error;
    }
  }
}
