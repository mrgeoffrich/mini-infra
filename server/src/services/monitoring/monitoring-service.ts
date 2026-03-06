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
  private readonly cadvisorContainerName: string;
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
    version: '1.0.0',
    description: 'Container metrics monitoring with cAdvisor and Prometheus',
    dependencies: ['docker'],
    tags: ['monitoring', 'metrics', 'prometheus', 'cadvisor', 'infrastructure'],
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
        name: 'cadvisor',
        containerPort: 8080,
        hostPort: 8080,
        protocol: 'tcp',
        description: 'cAdvisor container metrics'
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
    this.cadvisorContainerName = `${this.projectName}-cadvisor`;
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

      // Write Prometheus config to volume
      await this.writePrometheusConfig();

      // Deploy cAdvisor first (Prometheus depends on it)
      await this.deployCadvisor();

      // Deploy Prometheus
      await this.deployPrometheus();

      this.logger.info('Monitoring deployment completed successfully');
    } catch (error) {
      this.logger.error({ error }, 'Failed to deploy monitoring');
      throw error;
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

  private async writePrometheusConfig(): Promise<void> {
    const prometheusConfig = `global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: "cadvisor"
    static_configs:
      - targets: ["${this.cadvisorContainerName}:8080"]
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
          `mkdir -p /prometheus/config && echo '${escapedConfig}' > /prometheus/config/prometheus.yml`
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

  private async deployCadvisor(): Promise<void> {
    await this.dockerExecutor.pullImageWithAuth('gcr.io/cadvisor/cadvisor:v0.51.0');

    const container = await this.dockerExecutor.createLongRunningContainer({
      image: 'gcr.io/cadvisor/cadvisor:v0.51.0',
      name: this.cadvisorContainerName,
      projectName: this.projectName,
      serviceName: 'cadvisor',
      env: {},
      ports: {
        '8080/tcp': [{ HostPort: '8080' }]
      },
      mounts: [
        { Target: '/rootfs', Source: '/', Type: 'bind', ReadOnly: true },
        { Target: '/var/run', Source: '/var/run', Type: 'bind', ReadOnly: true },
        { Target: '/sys', Source: '/sys', Type: 'bind', ReadOnly: true },
        { Target: '/var/lib/docker/', Source: '/var/lib/docker/', Type: 'bind', ReadOnly: true },
        { Target: '/dev/disk/', Source: '/dev/disk/', Type: 'bind', ReadOnly: true }
      ],
      networks: this.availableNetworks.map(net => net.name),
      restartPolicy: 'unless-stopped',
      healthcheck: {
        Test: ['CMD', 'wget', '--quiet', '--tries=1', '--spider', 'http://localhost:8080/healthz'],
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
    this.logger.info('Started cAdvisor container');
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
      await this.dockerExecutor.removeProject(this.projectName);
      this.currentStatus = ServiceStatus.STOPPED;
      this.stoppedAt = new Date();
      this.logger.info('Monitoring service stopped successfully - network and volumes retained');
    } catch (error) {
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

      // Check both cadvisor and prometheus are running
      const cadvisorRunning = containers.some(c =>
        c.State === 'running' && c.Names?.some(name => name.includes(this.cadvisorContainerName))
      );
      const prometheusRunning = containers.some(c =>
        c.State === 'running' && c.Names?.some(name => name.includes(this.prometheusContainerName))
      );

      if (!cadvisorRunning || !prometheusRunning) {
        return {
          status: HealthStatus.UNHEALTHY,
          message: `Monitoring degraded: cAdvisor=${cadvisorRunning ? 'running' : 'stopped'}, Prometheus=${prometheusRunning ? 'running' : 'stopped'}`,
          lastChecked: new Date(),
          details: { cadvisorRunning, prometheusRunning }
        };
      }

      return {
        status: HealthStatus.HEALTHY,
        message: 'Monitoring service is healthy',
        lastChecked: new Date(),
        details: {
          runningContainers: runningContainers.length,
          totalContainers: containers.length,
          cadvisorRunning,
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

  getPrometheusUrl(): string {
    return `http://${this.prometheusContainerName}:9090`;
  }
}
