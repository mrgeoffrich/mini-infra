import { DockerExecutorService } from '../docker-executor';
import { servicesLogger } from '../../lib/logger-factory';
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
} from '../interfaces/application-service';

export class HAProxyService implements IApplicationService {
  private dockerExecutor: DockerExecutorService;
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
    // Note: Port mappings are dynamic and depend on:
    // 1. Manual port overrides (if configured in system settings)
    // 2. Environment network type:
    //    - local: HTTP 80, HTTPS 443, stats 8404, dataplane 5555
    //    - internet: HTTP 8111, HTTPS 8443, stats 8405, dataplane 5556
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
        hostPort: 8405,
        protocol: 'tcp',
        description: 'HAProxy statistics and monitoring'
      },
      {
        name: 'dataplane-api',
        containerPort: 5555,
        hostPort: 5556,
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
    this.projectName = projectName;
    this.mainContainerName = `${this.projectName}-haproxy`;
  }

  /**
   * Get the project name used for container discovery
   */
  getProjectName(): string {
    return this.projectName;
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
    this.currentStatus = ServiceStatus.RUNNING;
    this.startedAt = new Date();
    this.stoppedAt = undefined;
    this.lastError = undefined;

    return {
      success: true,
      message: 'HAProxy service marked as running (containers managed by stack reconciler)',
      duration: Date.now() - startTime,
    };
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
    // Pipe command via stdin to socat directly, avoiding shell interpolation
    // of PEM data and other content that may contain shell metacharacters
    const exec = await container.exec({
      Cmd: ['socat', 'stdio', `unix-connect:${sockPath}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({ hijack: true, stdin: true });

    return new Promise((resolve, reject) => {
      let output = '';
      stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      stream.on('end', () => resolve(output));
      stream.on('error', reject);

      // Send command via stdin — no shell metacharacter risk
      stream.write(command + '\n');
      stream.end();
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