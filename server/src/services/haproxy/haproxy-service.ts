import { DockerExecutorService } from '../docker-executor';
import { servicesLogger } from '../../lib/logger-factory';
import ContainerLabelManager from '../container-label-manager';
import { portUtils } from '../port-utils';
import * as path from 'path';
import Dockerode from 'dockerode';
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
      },
      {
        name: 'haproxy_certs'
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

      // Write config files directly to haproxy_config volume
      await this.writeConfigsToVolume();

      // Deploy main haproxy container
      await this.deployHAProxyContainer();

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

  /**
   * Write HAProxy config files directly to the haproxy_config volume
   */
  private async writeConfigsToVolume(): Promise<void> {
    const configVolumeName = this.getVolumeByName('haproxy_config')?.name || 'haproxy_config';
    this.logger.info({ volumeName: configVolumeName }, 'Writing config files to volume');

    // Read the config files
    const fs = await import('fs/promises');
    const haproxyCfg = await fs.readFile(
      path.join(process.cwd(), 'docker-compose', 'haproxy', 'haproxy.cfg'),
      'utf-8'
    );
    const dataplaneApiYml = await fs.readFile(
      path.join(process.cwd(), 'docker-compose', 'haproxy', 'dataplaneapi.yml'),
      'utf-8'
    );
    const domainBackendMap = await fs.readFile(
      path.join(process.cwd(), 'docker-compose', 'haproxy', 'domain-backend.map'),
      'utf-8'
    );

    // Escape the content for shell usage
    const escapedHaproxyCfg = haproxyCfg.replace(/'/g, "'\\''");
    const escapedDataplaneApiYml = dataplaneApiYml.replace(/'/g, "'\\''");
    const escapedDomainBackendMap = domainBackendMap.replace(/'/g, "'\\''");

    // Run a temporary container to write the configs to the volume
    const tempWriterName = `${this.projectName}-config-writer-${Date.now()}`;
    const docker = this.dockerExecutor.getDockerClient();

    try {
      // Pull alpine image first
      await this.dockerExecutor.pullImageWithAuth('alpine:latest');

      // Create a container that writes the configs directly to haproxy_config volume
      const container = await docker.createContainer({
        Image: 'alpine:latest',
        name: tempWriterName,
        Cmd: [
          'sh',
          '-c',
          `echo '${escapedHaproxyCfg}' > /usr/local/etc/haproxy/haproxy.cfg && echo '${escapedDataplaneApiYml}' > /usr/local/etc/haproxy/dataplaneapi.yml && echo '${escapedDomainBackendMap}' > /usr/local/etc/haproxy/domain-backend.map && chmod 666 /usr/local/etc/haproxy/haproxy.cfg && chmod 666 /usr/local/etc/haproxy/dataplaneapi.yml && chmod 666 /usr/local/etc/haproxy/domain-backend.map`
        ],
        HostConfig: {
          Binds: [`${configVolumeName}:/usr/local/etc/haproxy`],
          AutoRemove: true
        }
      });

      // Start and wait for completion
      await container.start();
      await container.wait();

      this.logger.info('Config files written to haproxy_config volume');
    } catch (error) {
      this.logger.error({ error }, 'Failed to write config files to volume');
      throw error;
    }
  }

  private getVolumeByName(name: string): VolumeRequirement | undefined {
    // Support both exact match and suffix match (for environment-prefixed volumes)
    // e.g., 'haproxy_config' will match 'env-123-haproxy_config'
    return this.availableVolumes.find(vol =>
      vol.name === name || vol.name.endsWith(`-${name}`)
    );
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
      mounts: [
        {
          Target: '/usr/local/etc/haproxy/',
          Source: this.getVolumeByName('haproxy_config')?.name || 'haproxy_config',
          Type: 'volume'
        },
        {
          Target: '/etc/ssl/certs',
          Source: this.getVolumeByName('haproxy_certs')?.name || 'haproxy_certs',
          Type: 'volume'
        }
      ],
      networks: this.availableNetworks.map(net => net.name),
      restartPolicy: 'unless-stopped',
      healthcheck: {
        Test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://admin:admin@127.0.0.1:8404/stats'],
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

  /**
   * Reload certificate via Runtime API (zero-downtime update)
   *
   * @param certPath - Path to certificate inside container
   * @param certPem - Combined certificate and private key PEM
   */
  async reloadCertificate(certPath: string, certPem: string): Promise<void> {
    this.logger.info({ certPath }, 'Reloading certificate via Runtime API');

    try {
      const containers = await this.getProjectContainers();
      const haproxyContainer = containers.find(
        c => c.State === 'running' && c.Names?.some(name => name.includes(this.mainContainerName))
      );

      if (!haproxyContainer || !haproxyContainer.Id) {
        throw new Error('HAProxy container not found or not running');
      }

      const docker = this.dockerExecutor.getDockerClient();
      const container = docker.getContainer(haproxyContainer.Id);
      const sockPath = '/var/run/haproxy.sock';

      // Use Runtime API to hot-reload certificate
      await this.executeRuntimeApiCommand(container, sockPath, `set ssl cert ${certPath} <<`);
      await this.executeRuntimeApiCommand(container, sockPath, certPem);
      await this.executeRuntimeApiCommand(container, sockPath, `commit ssl cert ${certPath}`);

      this.logger.info({ certPath }, 'Certificate reloaded successfully via Runtime API');
    } catch (error) {
      this.logger.error({ error, certPath }, 'Failed to reload certificate');
      throw error;
    }
  }

  /**
   * Execute Runtime API command via socat
   *
   * @param container - Docker container instance
   * @param sockPath - Path to HAProxy socket
   * @param command - Runtime API command
   * @returns Command output
   */
  private async executeRuntimeApiCommand(
    container: Dockerode.Container,
    sockPath: string,
    command: string
  ): Promise<string> {
    const cmd = `echo "${command}" | socat stdio unix-connect:${sockPath}`;

    const exec = await container.exec({
      Cmd: ['sh', '-c', cmd],
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      let output = '';
      stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      stream.on('end', () => resolve(output));
      stream.on('error', reject);
    });
  }

  /**
   * Find HAProxy container by label or name
   *
   * @returns HAProxy container info or null if not found
   */
  async findHAProxyContainer(): Promise<Dockerode.ContainerInfo | null> {
    const containers = await this.getProjectContainers();
    const haproxyContainer = containers.find(
      c => c.State === 'running' && c.Names?.some(name => name.includes(this.mainContainerName))
    );
    return haproxyContainer || null;
  }
}