import Docker from "dockerode";
import { servicesLogger } from "../../lib/logger-factory";

/**
 * ProjectManager - Manages Docker Compose-style project containers
 */
export class ProjectManager {
  private docker: Docker;

  constructor(docker: Docker) {
    this.docker = docker;
  }

  /**
   * Find all containers belonging to a compose project
   */
  public async getProjectContainers(projectName: string): Promise<Docker.ContainerInfo[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });

      return containers.filter(container =>
        container.Labels &&
        container.Labels['com.docker.compose.project'] === projectName
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          projectName,
        },
        "Failed to get project containers",
      );
      throw error;
    }
  }

  /**
   * Find containers by service name within a project
   */
  public async getServiceContainers(projectName: string, serviceName: string): Promise<Docker.ContainerInfo[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });

      return containers.filter(container =>
        container.Labels &&
        container.Labels['com.docker.compose.project'] === projectName &&
        container.Labels['com.docker.compose.service'] === serviceName
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          projectName,
          serviceName,
        },
        "Failed to get service containers",
      );
      throw error;
    }
  }

  /**
   * Find all containers managed by mini-infra
   */
  public async getManagedContainers(): Promise<Docker.ContainerInfo[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });

      return containers.filter(container =>
        container.Labels &&
        container.Labels['mini-infra.managed'] === 'true'
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get managed containers",
      );
      throw error;
    }
  }

  /**
   * Stop all containers in a compose project
   */
  public async stopProject(projectName: string): Promise<void> {
    const log = servicesLogger().child({ operation: 'stop-project', project: projectName });

    try {
      const containers = await this.getProjectContainers(projectName);

      for (const containerInfo of containers) {
        try {
          const container = this.docker.getContainer(containerInfo.Id);
          const info = await container.inspect();

          if (info.State.Running) {
            await container.stop();
            log.info({ container: containerInfo.Names[0] }, 'Stopped container');
          }
        } catch (error) {
          log.error({ error, container: containerInfo.Names[0] }, 'Failed to stop container');
        }
      }
    } catch (error) {
      log.error({ error }, 'Failed to stop project');
      throw error;
    }
  }

  /**
   * Remove all containers in a compose project
   */
  public async removeProject(projectName: string): Promise<void> {
    const log = servicesLogger().child({ operation: 'remove-project', project: projectName });

    try {
      const containers = await this.getProjectContainers(projectName);

      for (const containerInfo of containers) {
        try {
          const container = this.docker.getContainer(containerInfo.Id);
          const info = await container.inspect();

          if (info.State.Running) {
            await container.stop();
          }

          await container.remove();
          log.info({ container: containerInfo.Names[0] }, 'Removed container');
        } catch (error) {
          log.error({ error, container: containerInfo.Names[0] }, 'Failed to remove container');
        }
      }
    } catch (error) {
      log.error({ error }, 'Failed to remove project');
      throw error;
    }
  }
}
