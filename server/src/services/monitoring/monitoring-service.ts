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
    description: 'Container metrics monitoring with Telegraf and Prometheus',
    dependencies: ['docker'],
    tags: ['monitoring', 'metrics', 'prometheus', 'telegraf', 'infrastructure'],
    requiredNetworks: [
      {
        name: 'monitoring_network',
        driver: 'bridge'
      }
    ],
    requiredVolumes: [
      {
        name: 'prometheus_data'
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
      }
    ]
  };

  constructor(projectName: string = 'monitoring') {
    this.dockerExecutor = new DockerExecutorService();
    this.projectName = projectName;
    this.telegrafContainerName = `${this.projectName}-telegraf`;
    this.prometheusContainerName = `${this.projectName}-prometheus`;
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
    this.currentStatus = ServiceStatus.STARTING;

    try {
      await this.deployMonitoring();

      this.currentStatus = ServiceStatus.RUNNING;
      this.startedAt = new Date();
      this.stoppedAt = undefined;

      const duration = Date.now() - startTime;
      const result: StartupResult = {
        success: true,
        message: 'Monitoring service started successfully',
        duration,
        details: {
          projectName: this.projectName,
          networks: this.availableNetworks.map(n => n.name),
          volumes: this.availableVolumes.map(v => v.name)
        }
      };

      this.logger.info({ duration }, 'Monitoring service started successfully');
      return result;
    } catch (error) {
      this.currentStatus = ServiceStatus.FAILED;
      this.lastError = {
        message: error instanceof Error ? error.message : 'Failed to start',
        timestamp: new Date(),
        details: { phase: 'startup' }
      };

      const result: StartupResult = {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to start monitoring service',
        duration: Date.now() - startTime
      };

      this.logger.error({ error, duration: result.duration }, 'Monitoring service failed to start');
      return result;
    }
  }

  private async deployMonitoring(): Promise<void> {
    try {
      // Ensure network exists
      const networkExists = await this.networkExists();
      if (!networkExists) {
        await this.createNetwork();
      }

      // Create volumes
      await this.createVolumes();

      // Clean up any stale containers before deploying
      await this.removeStaleContainers();

      // Write configs to volumes
      await this.writeTelegrafConfig();
      await this.writePrometheusConfig();

      // Deploy Telegraf first (Prometheus depends on it)
      await this.deployTelegraf();

      // Deploy Prometheus
      await this.deployPrometheus();

      this.logger.info('Monitoring deployment completed successfully');
    } catch (error) {
      this.logger.error({ error }, 'Failed to deploy monitoring');
      throw error;
    }
  }

  /**
   * Find and remove any existing monitoring containers that are stopped, dead, or in a bad state.
   * Running containers are also stopped and removed so a clean deploy can proceed.
   */
  private async removeStaleContainers(): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();
    const allContainers = await docker.listContainers({ all: true });

    const monitoringContainers = allContainers.filter(c =>
      c.Names?.some(name =>
        name.includes(this.telegrafContainerName) ||
        name.includes(this.prometheusContainerName)
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

  private async networkExists(): Promise<boolean> {
    try {
      const docker = this.dockerExecutor.getDockerClient();
      const networks = await docker.listNetworks();

      for (const networkReq of this.availableNetworks) {
        const exists = networks.some(network => network.Name === networkReq.name);
        if (!exists) {
          this.logger.warn({ networkName: networkReq.name }, 'Required network does not exist');
          return false;
        }
      }
      return true;
    } catch (error) {
      this.logger.error({ error }, 'Failed to check if networks exist');
      return false;
    }
  }

  private async createNetwork(): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();
    const existingNetworks = await docker.listNetworks();

    for (const networkReq of this.availableNetworks) {
      const exists = existingNetworks.some(network => network.Name === networkReq.name);

      if (!exists) {
        this.logger.info({ networkName: networkReq.name }, 'Creating network');
        await this.dockerExecutor.createNetwork(networkReq.name, this.projectName, {
          driver: networkReq.driver || 'bridge',
          ...networkReq.options
        });
      } else {
        this.logger.debug({ networkName: networkReq.name }, 'Network already exists, skipping creation');
      }
    }
  }

  private async createVolumes(): Promise<void> {
    for (const volumeReq of this.availableVolumes) {
      await this.dockerExecutor.createVolume(volumeReq.name, this.projectName);
    }
  }

  private getVolumeByName(name: string): VolumeRequirement | undefined {
    return this.availableVolumes.find(vol =>
      vol.name === name || vol.name.endsWith(`-${name}`)
    );
  }

  private getTelegrafConfig(): string {
    return `[agent]
  interval = "10s"
  flush_interval = "10s"

[[inputs.docker]]
  endpoint = "unix:///var/run/docker.sock"
  gather_services = false
  source_tag = false
  timeout = "5s"
  perdevice_include = ["cpu"]
  total_include = ["cpu", "blkio", "network"]
  docker_label_include = []
  docker_label_exclude = []

[[outputs.prometheus_client]]
  listen = ":9273"
  metric_version = 2
  path = "/metrics"
`;
  }

  private async writeTelegrafConfig(): Promise<void> {
    const telegrafConfig = this.getTelegrafConfig();
    const configVolumeName = this.getVolumeByName('prometheus_data')?.name || 'prometheus_data';
    this.logger.info({ volumeName: configVolumeName }, 'Writing Telegraf config to volume');

    const tempWriterName = `${this.projectName}-telegraf-config-writer-${Date.now()}`;
    const docker = this.dockerExecutor.getDockerClient();

    try {
      await this.dockerExecutor.pullImageWithAuth('alpine:latest');

      const escapedConfig = telegrafConfig.replace(/'/g, "'\\''");

      const container = await docker.createContainer({
        Image: 'alpine:latest',
        name: tempWriterName,
        Cmd: [
          'sh',
          '-c',
          `mkdir -p /prometheus/config && echo '${escapedConfig}' > /prometheus/config/telegraf.conf`
        ],
        HostConfig: {
          Binds: [`${configVolumeName}:/prometheus`]
        }
      });

      try {
        await container.start();
        await container.wait();
        this.logger.info('Telegraf config written to volume');
      } finally {
        try {
          await container.remove({ force: true });
        } catch (cleanupError) {
          this.logger.warn({ error: cleanupError }, 'Failed to cleanup config writer container');
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to write Telegraf config to volume');
      throw error;
    }
  }

  private async writePrometheusConfig(): Promise<void> {
    const prometheusConfig = `global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: "telegraf"
    static_configs:
      - targets: ["${this.telegrafContainerName}:9273"]
`;

    const configVolumeName = this.getVolumeByName('prometheus_data')?.name || 'prometheus_data';
    this.logger.info({ volumeName: configVolumeName }, 'Writing Prometheus config to volume');

    const tempWriterName = `${this.projectName}-config-writer-${Date.now()}`;
    const docker = this.dockerExecutor.getDockerClient();

    try {
      await this.dockerExecutor.pullImageWithAuth('alpine:latest');

      const escapedConfig = prometheusConfig.replace(/'/g, "'\\''");

      const container = await docker.createContainer({
        Image: 'alpine:latest',
        name: tempWriterName,
        Cmd: [
          'sh',
          '-c',
          `mkdir -p /prometheus/config /prometheus/data && chown -R 65534:65534 /prometheus/data && echo '${escapedConfig}' > /prometheus/config/prometheus.yml`
        ],
        HostConfig: {
          Binds: [`${configVolumeName}:/prometheus`]
        }
      });

      try {
        await container.start();
        await container.wait();
        this.logger.info('Prometheus config written to volume');
      } finally {
        try {
          await container.remove({ force: true });
        } catch (cleanupError) {
          this.logger.warn({ error: cleanupError }, 'Failed to cleanup config writer container');
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to write Prometheus config to volume');
      throw error;
    }
  }

  private async deployTelegraf(): Promise<void> {
    await this.dockerExecutor.pullImageWithAuth('telegraf:latest');

    const dataVolumeName = this.getVolumeByName('prometheus_data')?.name || 'prometheus_data';

    const dockerSocketPath = process.platform === 'win32'
      ? '//var/run/docker.sock'
      : '/var/run/docker.sock';

    const container = await this.dockerExecutor.createLongRunningContainer({
      image: 'telegraf:latest',
      name: this.telegrafContainerName,
      projectName: this.projectName,
      serviceName: 'telegraf',
      user: 'root',
      env: {},
      ports: {
        '9273/tcp': [{ HostPort: '9273' }]
      },
      entrypoint: [
        'sh', '-c',
        'chmod 666 /var/run/docker.sock && exec /entrypoint.sh telegraf --config /telegraf-volume/config/telegraf.conf'
      ],
      mounts: [
        {
          Target: '/telegraf-volume',
          Source: dataVolumeName,
          Type: 'volume',
          ReadOnly: true
        },
        {
          Target: '/var/run/docker.sock',
          Source: dockerSocketPath,
          Type: 'bind',
          ReadOnly: false
        }
      ],
      networks: this.availableNetworks.map(net => net.name),
      restartPolicy: 'unless-stopped',
      healthcheck: {
        Test: ['CMD', 'wget', '--quiet', '--tries=1', '--spider', 'http://localhost:9273/metrics'],
        Interval: 30000000000,
        Timeout: 3000000000,
        Retries: 3,
        StartPeriod: 10000000000
      },
      logConfig: {
        Type: 'json-file',
        Config: {
          'max-size': '10m',
          'max-file': '3'
        }
      }
    });

    await container.start();
    this.logger.info('Started Telegraf container');
  }

  private async deployPrometheus(): Promise<void> {
    await this.dockerExecutor.pullImageWithAuth('prom/prometheus:v3.3.0');

    const dataVolumeName = this.getVolumeByName('prometheus_data')?.name || 'prometheus_data';

    const container = await this.dockerExecutor.createLongRunningContainer({
      image: 'prom/prometheus:v3.3.0',
      name: this.prometheusContainerName,
      projectName: this.projectName,
      serviceName: 'prometheus',
      env: {},
      cmd: [
        '--config.file=/prometheus/config/prometheus.yml',
        '--storage.tsdb.path=/prometheus/data',
        '--storage.tsdb.retention.time=30d',
        '--web.enable-lifecycle'
      ],
      ports: {
        '9090/tcp': [{ HostPort: '9090' }]
      },
      mounts: [
        {
          Target: '/prometheus',
          Source: dataVolumeName,
          Type: 'volume'
        }
      ],
      networks: this.availableNetworks.map(net => net.name),
      restartPolicy: 'unless-stopped',
      healthcheck: {
        Test: ['CMD', 'wget', '--quiet', '--tries=1', '--spider', 'http://localhost:9090/-/healthy'],
        Interval: 30000000000,
        Timeout: 3000000000,
        Retries: 3,
        StartPeriod: 10000000000
      },
      logConfig: {
        Type: 'json-file',
        Config: {
          'max-size': '10m',
          'max-file': '3'
        }
      }
    });

    await container.start();
    this.logger.info('Started Prometheus container');
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

  private async findMonitoringContainers(): Promise<Docker.ContainerInfo[]> {
    const docker = this.dockerExecutor.getDockerClient();
    const allContainers = await docker.listContainers({ all: true });
    return allContainers.filter(c =>
      c.Names?.some(name =>
        name.includes(this.telegrafContainerName) ||
        name.includes(this.prometheusContainerName)
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

      if (!telegrafRunning || !prometheusRunning) {
        return {
          status: HealthStatus.UNHEALTHY,
          message: `Monitoring degraded: Telegraf=${telegrafRunning ? 'running' : 'stopped'}, Prometheus=${prometheusRunning ? 'running' : 'stopped'}`,
          lastChecked: new Date(),
          details: { telegrafRunning, prometheusRunning }
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
          prometheusRunning
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
        n.includes(this.telegrafContainerName) || n.includes(this.prometheusContainerName)
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

  getPrometheusUrl(): string {
    // When the server runs inside Docker, use the container name on the shared network.
    // When running on the host, use localhost with the published port.
    const inDocker = existsSync('/.dockerenv');
    return inDocker
      ? `http://${this.prometheusContainerName}:9090`
      : 'http://localhost:9090';
  }
}
