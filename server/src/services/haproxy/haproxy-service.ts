import { DockerExecutorService } from '../docker-executor';
import { servicesLogger } from '../../lib/logger-factory';
import ContainerLabelManager from '../container-label-manager';
import { portUtils } from '../port-utils';
import * as path from 'path';
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
  PortRequirement
} from '../interfaces/application-service';

export class HAProxyService implements IApplicationService {
  private dockerExecutor: DockerExecutorService;
  private labelManager: ContainerLabelManager;
  private readonly projectName: string;
  private readonly initContainerName: string;
  private readonly mainContainerName: string;
  private readonly logger = servicesLogger();
  private currentStatus: ServiceStatus = ServiceStatus.UNINITIALIZED;
  private startedAt?: Date;
  private stoppedAt?: Date;
  private lastError?: { message: string; timestamp: Date; details?: Record<string, any> };
  private availableNetworks: NetworkRequirement[] = [];
  private availableVolumes: VolumeRequirement[] = [];

  readonly metadata: ServiceMetadata = {
    name: 'haproxy',
    version: '3.2.0',
    description: 'HAProxy load balancer with DataPlane API',
    dependencies: ['docker'], // Depends on docker service being available
    tags: ['load-balancer', 'haproxy', 'infrastructure'],
    requiredNetworks: [
      {
        name: 'haproxy_network',
        driver: 'bridge'
      }
    ],
    requiredVolumes: [
      {
        name: 'haproxy_data'
      },
      {
        name: 'haproxy_run'
      },
      {
        name: 'haproxy_config'
      }
    ],
    // Note: HTTP/HTTPS port mappings are dynamic and depend on:
    // 1. Manual port overrides (if configured in system settings)
    // 2. Environment network type (local: 80/443, internet: 8111/8443)
    // The values below are defaults for 'internet' network type
    exposedPorts: [
      {
        name: 'http',
        containerPort: 80,
        hostPort: 8111,
        protocol: 'tcp',
        description: 'HTTP traffic'
      },
      {
        name: 'https',
        containerPort: 443,
        hostPort: 8443,
        protocol: 'tcp',
        description: 'HTTPS traffic'
      },
      {
        name: 'stats',
        containerPort: 8404,
        hostPort: 8404,
        protocol: 'tcp',
        description: 'HAProxy statistics and monitoring'
      },
      {
        name: 'dataplane-api',
        containerPort: 5555,
        hostPort: 5555,
        protocol: 'tcp',
        description: 'HAProxy DataPlane API'
      }
    ]
  };

  constructor(
    projectName: string = 'haproxy',
    private environmentId?: string
  ) {
    this.dockerExecutor = new DockerExecutorService();
    this.labelManager = new ContainerLabelManager();
    this.projectName = projectName;
    this.initContainerName = `${this.projectName}-haproxy-init`;
    this.mainContainerName = `${this.projectName}-haproxy`;
  }

  /**
   * Initialize the HAProxy service
   */
  async initialize(networks?: NetworkRequirement[], volumes?: VolumeRequirement[]): Promise<void> {
    this.currentStatus = ServiceStatus.INITIALIZING;
    try {
      // Store the provided networks and volumes
      this.availableNetworks = networks || [];
      this.availableVolumes = volumes || [];

      await this.dockerExecutor.initialize();
      this.currentStatus = ServiceStatus.INITIALIZED;
      this.logger.info({
        networksCount: this.availableNetworks.length,
        volumesCount: this.availableVolumes.length
      }, 'HAProxy service initialized with provided resources');
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

  /**
   * Start the HAProxy service (implements IApplicationService)
   */
  async start(): Promise<StartupResult> {
    const startTime = Date.now();
    this.currentStatus = ServiceStatus.STARTING;

    try {
      await this.deployHAProxy();

      this.currentStatus = ServiceStatus.RUNNING;
      this.startedAt = new Date();
      this.stoppedAt = undefined;

      const duration = Date.now() - startTime;
      const result: StartupResult = {
        success: true,
        message: 'HAProxy service started successfully',
        duration,
        details: {
          projectName: this.projectName,
          networks: this.availableNetworks.map(n => n.name),
          volumes: this.availableVolumes.map(v => v.name)
        }
      };

      this.logger.info({ duration }, 'HAProxy service started successfully');
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
        message: error instanceof Error ? error.message : 'Failed to start HAProxy service',
        duration: Date.now() - startTime
      };

      this.logger.error({ error, duration: result.duration }, 'HAProxy service failed to start');
      return result;
    }
  }

  async deployHAProxy(): Promise<void> {
    try {
      // Check if network exists, create if it doesn't
      const networkExists = await this.networkExists();
      if (!networkExists) {
        await this.createNetwork();
      }

      // Create named volumes
      await this.createVolumes();

      // Deploy haproxy-init container first
      await this.deployInitContainer();

      // Wait for init container to complete
      await this.waitForInitCompletion();

      // Deploy main haproxy container
      await this.deployHAProxyContainer();

      // Cleanup init container after main container is running
      await this.cleanupInitContainer();

      this.logger.info('HAProxy deployment completed successfully');
    } catch (error) {
      this.logger.error({ error }, 'Failed to deploy HAProxy');
      throw error;
    }
  }

  private async networkExists(): Promise<boolean> {
    try {
      const docker = this.dockerExecutor.getDockerClient();
      const networks = await docker.listNetworks();

      // Check if all required networks exist
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

    // Create each required network only if it doesn't exist
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
    // Use the stored volume requirements instead of hardcoded list
    for (const volumeReq of this.availableVolumes) {
      await this.dockerExecutor.createVolume(volumeReq.name, this.projectName);
    }
  }

  private getVolumeByName(name: string): VolumeRequirement | undefined {
    return this.availableVolumes.find(vol => vol.name === name);
  }

  private async deployInitContainer(): Promise<void> {
    // Pull image first
    await this.dockerExecutor.pullImageWithAuth('haproxytech/haproxy-alpine:3.2');

    const container = await this.dockerExecutor.createLongRunningContainer({
      image: 'haproxytech/haproxy-alpine:3.2',
      name: this.initContainerName,
      projectName: this.projectName,
      serviceName: 'haproxy-init',
      env: {},
      labels: this.environmentId ? this.labelManager.generateHAProxyLabels({
        environmentId: this.environmentId,
        projectName: this.projectName,
        serviceName: 'haproxy-init'
      }) : undefined,
      cmd: [
        'sh',
        '-c',
        'cp /tmp/haproxy.cfg /usr/local/etc/haproxy/haproxy.cfg && cp /tmp/dataplaneapi.yml /usr/local/etc/haproxy/dataplaneapi.yml && chmod 666 /usr/local/etc/haproxy/dataplaneapi.yml && chmod 666 /usr/local/etc/haproxy/haproxy.cfg'
      ],
      volumes: [
        `${path.join(process.cwd(), 'docker-compose', 'haproxy', 'dataplaneapi.yml')}:/tmp/dataplaneapi.yml:ro`,
        `${path.join(process.cwd(), 'docker-compose', 'haproxy', 'haproxy.cfg')}:/tmp/haproxy.cfg:ro`
      ],
      mounts: [
        {
          Target: '/usr/local/etc/haproxy/',
          Source: this.getVolumeByName('haproxy_config')?.name || 'haproxy_config',
          Type: 'volume'
        }
      ]
    });

    await container.start();
    this.logger.info('Started haproxy-init container');
  }

  private async waitForInitCompletion(): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();
    const container = docker.getContainer(this.initContainerName);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Init container timeout'));
      }, 60000); // 1 minute timeout

      const checkStatus = async () => {
        try {
          const info = await container.inspect();

          if (info.State.Status === 'exited') {
            clearTimeout(timeout);
            if (info.State.ExitCode === 0) {
              this.logger.info('Init container completed successfully');
              resolve();
            } else {
              reject(new Error(`Init container failed with exit code ${info.State.ExitCode}`));
            }
          } else {
            setTimeout(checkStatus, 1000);
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      };

      checkStatus();
    });
  }

  private async deployHAProxyContainer(): Promise<void> {
    await this.dockerExecutor.pullImageWithAuth('haproxytech/haproxy-alpine:3.2');

    // Get dynamic port configuration based on environment
    let httpPort = 8111; // Default for internet/no environment
    let httpsPort = 8443;

    if (this.environmentId) {
      try {
        const portConfig = await portUtils.getHAProxyPortsForEnvironment(this.environmentId);
        httpPort = portConfig.httpPort;
        httpsPort = portConfig.httpsPort;
        this.logger.info(
          {
            environmentId: this.environmentId,
            httpPort,
            httpsPort,
            source: portConfig.source
          },
          'Using dynamic port configuration for HAProxy'
        );
      } catch (error) {
        this.logger.warn(
          { error, environmentId: this.environmentId },
          'Failed to get dynamic ports, using defaults'
        );
      }
    }

    const container = await this.dockerExecutor.createLongRunningContainer({
      image: 'haproxytech/haproxy-alpine:3.2',
      name: this.mainContainerName,
      projectName: this.projectName,
      serviceName: 'haproxy',
      env: {
        'HAPROXY_DATACENTER': 'docker',
        'HAPROXY_MWORKER': '1',
        'DATAPLANEAPI_USERLIST_FILE': '/usr/local/etc/haproxy/haproxy.cfg'
      },
      labels: this.environmentId ? this.labelManager.generateHAProxyLabels({
        environmentId: this.environmentId,
        projectName: this.projectName,
        serviceName: 'haproxy'
      }) : undefined,
      ports: {
        '80/tcp': [{ HostPort: httpPort.toString() }],
        '443/tcp': [{ HostPort: httpsPort.toString() }],
        '8404/tcp': [{ HostPort: '8404' }],
        '5555/tcp': [{ HostPort: '5555' }]
      },
      volumes: [
        `${path.join(process.cwd(), 'docker-compose', 'haproxy', 'certs')}:/etc/ssl/certs:rw`
      ],
      mounts: [
        {
          Target: '/usr/local/etc/haproxy/',
          Source: this.getVolumeByName('haproxy_config')?.name || 'haproxy_config',
          Type: 'volume'
        }
      ],
      networks: this.availableNetworks.map(net => net.name),
      restartPolicy: 'unless-stopped',
      healthcheck: {
        Test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:8404/stats'],
        Interval: 30000000000, // 30s in nanoseconds
        Timeout: 5000000000,   // 5s in nanoseconds
        Retries: 3,
        StartPeriod: 10000000000 // 10s in nanoseconds
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
    this.logger.info('Started haproxy container');
  }

  /**
   * Capture logs and remove the init container after successful deployment
   */
  private async cleanupInitContainer(): Promise<void> {
    try {
      this.logger.info({ containerName: this.initContainerName }, 'Starting init container cleanup');

      // Capture logs before removing the container
      const { stdout, stderr } = await this.dockerExecutor.captureContainerLogs(
        this.initContainerName,
        { tail: 100, includeTimestamps: true }
      );

      // Log the captured output for debugging and audit purposes
      if (stdout.trim()) {
        this.logger.info(
          {
            containerName: this.initContainerName,
            stdout: stdout.trim()
          },
          'HAProxy init container stdout'
        );
      }

      if (stderr.trim()) {
        this.logger.info(
          {
            containerName: this.initContainerName,
            stderr: stderr.trim()
          },
          'HAProxy init container stderr'
        );
      }

      // Remove the init container
      const docker = this.dockerExecutor.getDockerClient();
      const container = docker.getContainer(this.initContainerName);
      await container.remove({ force: true });

      this.logger.info({ containerName: this.initContainerName }, 'Init container cleaned up successfully');
    } catch (error) {
      // Log cleanup failure as warning to avoid breaking the deployment
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          containerName: this.initContainerName
        },
        'Failed to cleanup init container - continuing with deployment'
      );
    }
  }

  /**
   * Stop the HAProxy service (implements IApplicationService)
   */
  async stopAndCleanup(): Promise<void> {
    this.currentStatus = ServiceStatus.STOPPING;
    try {
      await this.removeHAProxy();
      this.currentStatus = ServiceStatus.STOPPED;
      this.stoppedAt = new Date();
      this.logger.info('HAProxy service stopped successfully');
    } catch (error) {
      this.currentStatus = ServiceStatus.FAILED;
      this.lastError = {
        message: error instanceof Error ? error.message : 'Failed to stop',
        timestamp: new Date(),
        details: { phase: 'shutdown' }
      };
      this.logger.error({ error }, 'HAProxy service failed to stop');
      throw error;
    }
  }

  async removeHAProxy(): Promise<void> {
    try {
      // Stop and remove all containers in the project
      await this.dockerExecutor.removeProject(this.projectName);

      // Intentionally do NOT remove network and volumes

      this.logger.info('HAProxy cleanup completed - network and volumes retained');
    } catch (error) {
      this.logger.error({ error }, 'Failed to cleanup HAProxy');
      throw error;
    }
  }


  /**
   * Find all containers belonging to this compose project
   */
  async getProjectContainers() {
    return this.dockerExecutor.getProjectContainers(this.projectName);
  }

  /**
   * Find containers by service name within the project
   */
  async getServiceContainers(serviceName: string) {
    return this.dockerExecutor.getServiceContainers(this.projectName, serviceName);
  }

  /**
   * Stop all containers in the compose project
   */
  async stopProject(): Promise<void> {
    await this.dockerExecutor.stopProject(this.projectName);
  }

  /**
   * Remove all containers in the compose project
   */
  async removeProject(): Promise<void> {
    await this.dockerExecutor.removeProject(this.projectName);
  }

  /**
   * Get current service status (implements IApplicationService)
   */
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

  /**
   * Perform health check (implements IApplicationService)
   */
  async healthCheck(): Promise<ServiceHealth> {
    try {
      // Check if containers are running
      const containers = await this.getProjectContainers();
      const runningContainers = containers.filter(c => c.State === 'running');

      if (runningContainers.length === 0) {
        return {
          status: HealthStatus.UNHEALTHY,
          message: 'No HAProxy containers are running',
          lastChecked: new Date(),
          details: { totalContainers: containers.length, runningContainers: 0 }
        };
      }

      // Check if main haproxy container is healthy
      const haproxyContainers = containers.filter(c =>
        c.Names?.some(name => name.includes(this.mainContainerName))
      );

      if (haproxyContainers.length === 0) {
        return {
          status: HealthStatus.UNHEALTHY,
          message: 'Main HAProxy container not found',
          lastChecked: new Date(),
          details: { containers: containers.map(c => c.Names) }
        };
      }

      const mainContainer = haproxyContainers[0];
      if (mainContainer.State !== 'running') {
        return {
          status: HealthStatus.UNHEALTHY,
          message: `Main HAProxy container is ${mainContainer.State}`,
          lastChecked: new Date(),
          details: { containerState: mainContainer.State }
        };
      }

      return {
        status: HealthStatus.HEALTHY,
        message: 'HAProxy service is healthy',
        lastChecked: new Date(),
        details: {
          runningContainers: runningContainers.length,
          totalContainers: containers.length,
          mainContainerState: mainContainer.State
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

  /**
   * Check if service is ready to start (implements IApplicationService)
   */
  async isReadyToStart(): Promise<boolean> {
    try {
      // Check if docker executor is available
      await this.dockerExecutor.initialize();

      // Check if we're in a state that allows starting
      return this.currentStatus === ServiceStatus.INITIALIZED ||
        this.currentStatus === ServiceStatus.STOPPED ||
        this.currentStatus === ServiceStatus.FAILED;
    } catch (error) {
      this.logger.warn({ error }, 'HAProxy service readiness check failed');
      return false;
    }
  }
}