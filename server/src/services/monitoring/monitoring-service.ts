import { existsSync } from 'fs';
import Docker from 'dockerode';
import { DockerExecutorService } from '../docker-executor';
import { servicesLogger } from '../../lib/logger-factory';
import {
  IApplicationService,
  ServiceStatus,
  ServiceHealth,
  ServiceMetadata,
  ServiceStatusInfo,
  StartupResult,
  HealthStatus,
  NetworkRequirement,
  VolumeRequirement,
} from '../interfaces/application-service';

export class MonitoringService implements IApplicationService {
  private dockerExecutor: DockerExecutorService;
  private readonly projectName: string;
  private readonly telegrafContainerName: string;
  private readonly prometheusContainerName: string;
  private readonly lokiContainerName: string;
  private readonly alloyContainerName: string;
  private readonly logger = servicesLogger();
  private currentStatus: ServiceStatus = ServiceStatus.UNINITIALIZED;
  private startedAt?: Date;
  private stoppedAt?: Date;
  private lastError?: { message: string; timestamp: Date; details?: Record<string, any> };
  private availableNetworks: NetworkRequirement[] = [];
  private availableVolumes: VolumeRequirement[] = [];

  readonly metadata: ServiceMetadata = {
    name: 'monitoring',
    version: '2.0.0',
    description: 'Container metrics monitoring with Telegraf, Prometheus, and centralized log collection with Loki and Alloy',
    dependencies: ['docker'],
    tags: ['monitoring', 'metrics', 'prometheus', 'telegraf', 'loki', 'alloy', 'logging', 'infrastructure'],
    requiredNetworks: [
      {
        name: 'monitoring_network',
        driver: 'bridge'
      }
    ],
    requiredVolumes: [
      {
        name: 'prometheus_data'
      },
      {
        name: 'loki_data'
      }
    ],
    exposedPorts: [
      {
        name: 'telegraf',
        containerPort: 9273,
        hostPort: 9273,
        protocol: 'tcp',
        description: 'Telegraf Prometheus metrics endpoint'
      },
      {
        name: 'prometheus',
        containerPort: 9090,
        hostPort: 9090,
        protocol: 'tcp',
        description: 'Prometheus query and UI'
      },
      {
        name: 'loki',
        containerPort: 3100,
        hostPort: 3100,
        protocol: 'tcp',
        description: 'Loki log storage and query API'
      },
      {
        name: 'alloy',
        containerPort: 12345,
        hostPort: 12345,
        protocol: 'tcp',
        description: 'Alloy collector debug UI'
      }
    ]
  };

  constructor(projectName: string = 'monitoring') {
    this.dockerExecutor = new DockerExecutorService();
    this.projectName = projectName;
    this.telegrafContainerName = `${this.projectName}-telegraf`;
    this.prometheusContainerName = `${this.projectName}-prometheus`;
    this.lokiContainerName = `${this.projectName}-loki`;
    this.alloyContainerName = `${this.projectName}-alloy`;
  }

  getProjectName(): string {
    return this.projectName;
  }

  async initialize(networks?: NetworkRequirement[], volumes?: VolumeRequirement[]): Promise<void> {
    this.currentStatus = ServiceStatus.INITIALIZING;
    try {
      this.availableNetworks = networks || [];
      this.availableVolumes = volumes || [];

      await this.dockerExecutor.initialize();
      this.currentStatus = ServiceStatus.INITIALIZED;
      this.logger.info({
        networksCount: this.availableNetworks.length,
        volumesCount: this.availableVolumes.length
      }, 'Monitoring service initialized with provided resources');
    } catch (error) {
      this.currentStatus = ServiceStatus.FAILED;
      this.lastError = {
        message: error instanceof Error ? error.message : 'Failed to initialize',
        timestamp: new Date(),
        details: { phase: 'initialization' }
      };
      throw error;
    }
  }

  async start(): Promise<StartupResult> {
    const startTime = Date.now();
    this.currentStatus = ServiceStatus.RUNNING;
    this.startedAt = new Date();
    this.stoppedAt = undefined;
    this.lastError = undefined;

    return {
      success: true,
      message: 'Monitoring service marked as running (containers managed by stack reconciler)',
      duration: Date.now() - startTime,
    };
  }

  async stopAndCleanup(): Promise<void> {
    this.currentStatus = ServiceStatus.STOPPING;
    try {
      // removeProject handles already-stopped containers gracefully
      await this.dockerExecutor.removeProject(this.projectName);

      // Also clean up any containers matched by name that may not have project labels
      // (e.g. orphans from a failed deploy)
      await this.removeStaleContainers();

      this.currentStatus = ServiceStatus.STOPPED;
      this.stoppedAt = new Date();
      this.logger.info('Monitoring service stopped successfully - network and volumes retained');
    } catch (error) {
      // If all containers are already gone, treat as success
      const containers = await this.dockerExecutor.getProjectContainers(this.projectName).catch(() => []);
      const staleContainers = await this.findMonitoringContainers().catch(() => []);

      if (containers.length === 0 && staleContainers.length === 0) {
        this.currentStatus = ServiceStatus.STOPPED;
        this.stoppedAt = new Date();
        this.logger.info('Monitoring containers already removed - treating as stopped');
        return;
      }

      this.currentStatus = ServiceStatus.FAILED;
      this.lastError = {
        message: error instanceof Error ? error.message : 'Failed to stop',
        timestamp: new Date(),
        details: { phase: 'shutdown' }
      };
      this.logger.error({ error }, 'Monitoring service failed to stop');
      throw error;
    }
  }

  private async removeStaleContainers(): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();
    const allContainers = await docker.listContainers({ all: true });

    const monitoringContainers = allContainers.filter(c =>
      c.Names?.some(name =>
        name.includes(this.telegrafContainerName) ||
        name.includes(this.prometheusContainerName) ||
        name.includes(this.lokiContainerName) ||
        name.includes(this.alloyContainerName)
      )
    );

    for (const containerInfo of monitoringContainers) {
      const containerName = containerInfo.Names?.[0] || containerInfo.Id;
      try {
        const container = docker.getContainer(containerInfo.Id);
        if (containerInfo.State === 'running') {
          this.logger.info({ container: containerName }, 'Stopping existing monitoring container');
          await container.stop();
        }
        await container.remove({ force: true });
        this.logger.info({ container: containerName }, 'Removed stale monitoring container');
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('404') || msg.includes('no such container')) {
          continue;
        }
        this.logger.warn({ error, container: containerName }, 'Failed to remove stale container, continuing anyway');
      }
    }
  }

  private async findMonitoringContainers(): Promise<Docker.ContainerInfo[]> {
    const docker = this.dockerExecutor.getDockerClient();
    const allContainers = await docker.listContainers({ all: true });
    return allContainers.filter(c =>
      c.Names?.some(name =>
        name.includes(this.telegrafContainerName) ||
        name.includes(this.prometheusContainerName) ||
        name.includes(this.lokiContainerName) ||
        name.includes(this.alloyContainerName)
      )
    );
  }

  async getStatus(): Promise<ServiceStatusInfo> {
    const health = await this.healthCheck();

    return {
      status: this.currentStatus,
      health,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      metadata: this.metadata,
      lastError: this.lastError
    };
  }

  async healthCheck(): Promise<ServiceHealth> {
    try {
      const containers = await this.dockerExecutor.getProjectContainers(this.projectName);
      const runningContainers = containers.filter(c => c.State === 'running');

      if (runningContainers.length === 0) {
        return {
          status: HealthStatus.UNHEALTHY,
          message: 'No monitoring containers are running',
          lastChecked: new Date(),
          details: { totalContainers: containers.length, runningContainers: 0 }
        };
      }

      const telegrafRunning = containers.some(c =>
        c.State === 'running' && c.Names?.some(name => name.includes(this.telegrafContainerName))
      );
      const prometheusRunning = containers.some(c =>
        c.State === 'running' && c.Names?.some(name => name.includes(this.prometheusContainerName))
      );
      const lokiRunning = containers.some(c =>
        c.State === 'running' && c.Names?.some(name => name.includes(this.lokiContainerName))
      );
      const alloyRunning = containers.some(c =>
        c.State === 'running' && c.Names?.some(name => name.includes(this.alloyContainerName))
      );

      if (!telegrafRunning || !prometheusRunning || !lokiRunning || !alloyRunning) {
        const services = [
          `Telegraf=${telegrafRunning ? 'running' : 'stopped'}`,
          `Prometheus=${prometheusRunning ? 'running' : 'stopped'}`,
          `Loki=${lokiRunning ? 'running' : 'stopped'}`,
          `Alloy=${alloyRunning ? 'running' : 'stopped'}`
        ].join(', ');
        return {
          status: HealthStatus.UNHEALTHY,
          message: `Monitoring degraded: ${services}`,
          lastChecked: new Date(),
          details: { telegrafRunning, prometheusRunning, lokiRunning, alloyRunning }
        };
      }

      return {
        status: HealthStatus.HEALTHY,
        message: 'Monitoring service is healthy',
        lastChecked: new Date(),
        details: {
          runningContainers: runningContainers.length,
          totalContainers: containers.length,
          telegrafRunning,
          prometheusRunning,
          lokiRunning,
          alloyRunning
        }
      };
    } catch (error) {
      return {
        status: HealthStatus.UNKNOWN,
        message: error instanceof Error ? error.message : 'Health check failed',
        lastChecked: new Date(),
        details: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }

  async isReadyToStart(): Promise<boolean> {
    try {
      await this.dockerExecutor.initialize();

      return this.currentStatus === ServiceStatus.INITIALIZED ||
        this.currentStatus === ServiceStatus.STOPPED ||
        this.currentStatus === ServiceStatus.FAILED;
    } catch (error) {
      this.logger.warn({ error }, 'Monitoring service readiness check failed');
      return false;
    }
  }

  /**
   * Force-remove all monitoring containers regardless of state.
   * Use when normal stop fails or containers are stuck.
   */
  async forceRemove(): Promise<{ removed: string[]; errors: string[] }> {
    const removed: string[] = [];
    const errors: string[] = [];

    // Remove by project label
    try {
      const projectContainers = await this.dockerExecutor.getProjectContainers(this.projectName);
      for (const containerInfo of projectContainers) {
        const name = containerInfo.Names?.[0] || containerInfo.Id;
        try {
          const docker = this.dockerExecutor.getDockerClient();
          const container = docker.getContainer(containerInfo.Id);
          await container.remove({ force: true });
          removed.push(name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('404') && !msg.includes('no such container')) {
            errors.push(`${name}: ${msg}`);
          }
        }
      }
    } catch {
      // Ignore — try by name next
    }

    // Also remove by name (catches orphans without project labels)
    const docker = this.dockerExecutor.getDockerClient();
    const allContainers = await docker.listContainers({ all: true });
    const orphans = allContainers.filter(c =>
      c.Names?.some(n =>
        n.includes(this.telegrafContainerName) || n.includes(this.prometheusContainerName) ||
        n.includes(this.lokiContainerName) || n.includes(this.alloyContainerName)
      ) && !removed.some(r => c.Names?.some(n => n.includes(r.replace('/', ''))))
    );

    for (const containerInfo of orphans) {
      const name = containerInfo.Names?.[0] || containerInfo.Id;
      try {
        const container = docker.getContainer(containerInfo.Id);
        await container.remove({ force: true });
        removed.push(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('404') && !msg.includes('no such container')) {
          errors.push(`${name}: ${msg}`);
        }
      }
    }

    this.currentStatus = ServiceStatus.STOPPED;
    this.stoppedAt = new Date();
    this.logger.info({ removed, errors }, 'Force remove completed');

    return { removed, errors };
  }

  /**
   * Mark the service as running without deploying containers.
   * Used when recovering the in-memory state after a server restart
   * while containers are still running from a previous session.
   */
  markAsRunning(): void {
    this.currentStatus = ServiceStatus.RUNNING;
    this.startedAt = this.startedAt || new Date();
    this.lastError = undefined;
  }

  getPrometheusUrl(): string {
    // When the server runs inside Docker, use the container name on the shared network.
    // When running on the host, use localhost with the published port.
    const inDocker = existsSync('/.dockerenv');
    return inDocker
      ? `http://${this.prometheusContainerName}:9090`
      : 'http://localhost:9090';
  }

  getLokiUrl(): string {
    const inDocker = existsSync('/.dockerenv');
    return inDocker
      ? `http://${this.lokiContainerName}:3100`
      : 'http://localhost:3100';
  }
}
