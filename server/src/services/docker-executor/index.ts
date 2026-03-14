import Docker, { Container } from "dockerode";
import { servicesLogger } from "../../lib/logger-factory";
import prisma from "../../lib/prisma";
import { DockerConfigService } from "../docker-config";
import ContainerLabelManager from "../container/container-label-manager";
import { RegistryCredentialService } from "../registry-credential";

import { DockerClientFactory } from "./docker-client-factory";
import { ContainerExecutor } from "./container-executor";
import { ContainerMonitor } from "./container-monitor";
import { RegistryManager } from "./registry-manager";
import { ProjectManager } from "./project-manager";
import { InfrastructureManager } from "./infrastructure-manager";
import { LongRunningContainerManager } from "./long-running-container";
import { getDockerNetworkName } from "./utils";

import type {
  ContainerExecutionOptions,
  ContainerExecutionResult,
  ContainerProgress,
  DockerRegistryTestOptions,
  DockerRegistryTestResult,
} from "./types";

// Re-export all types for consumers
export type {
  ContainerExecutionOptions,
  ContainerExecutionResult,
  ContainerProgress,
  DockerRegistryTestOptions,
  DockerRegistryTestResult,
};

// Re-export sub-modules for advanced usage
export { DockerClientFactory } from "./docker-client-factory";
export { ContainerExecutor } from "./container-executor";
export { ContainerMonitor } from "./container-monitor";
export { RegistryManager } from "./registry-manager";
export { ProjectManager } from "./project-manager";
export { InfrastructureManager } from "./infrastructure-manager";
export { LongRunningContainerManager } from "./long-running-container";

/**
 * DockerExecutorService - Facade that preserves the original public API
 *
 * Delegates to focused sub-modules for each responsibility area.
 * All 21 consumer import paths continue to work unchanged.
 *
 * Uses a setter on `docker` so that sub-modules are rebuilt whenever
 * the Docker client is replaced (including by tests that set it directly).
 */
export class DockerExecutorService {
  private _docker: Docker;
  private dockerConfigService: DockerConfigService;
  private labelManager: ContainerLabelManager;
  private registryCredentialService: RegistryCredentialService;
  private clientFactory: DockerClientFactory;
  private static readonly DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  private executor!: ContainerExecutor;
  private monitor!: ContainerMonitor;
  private registry!: RegistryManager;
  private projectMgr!: ProjectManager;
  private infraMgr!: InfrastructureManager;
  private longRunningMgr!: LongRunningContainerManager;

  constructor() {
    this.dockerConfigService = new DockerConfigService(prisma);
    this.labelManager = new ContainerLabelManager();
    this.registryCredentialService = new RegistryCredentialService(prisma);
    this.clientFactory = new DockerClientFactory(this.dockerConfigService);
    // Initialize Docker client placeholder - will be set up asynchronously
    this._docker = {} as Docker;
    this.rebuildSubModules();
  }

  /**
   * Getter/setter for docker so sub-modules are rebuilt when the client changes.
   * Tests set `(service as any).docker = mock` -- the setter intercepts this.
   */
  private get docker(): Docker {
    return this._docker;
  }

  private set docker(value: Docker) {
    this._docker = value;
    this.rebuildSubModules();
  }

  private rebuildSubModules(): void {
    this.executor = new ContainerExecutor(this._docker, this.labelManager);
    this.monitor = new ContainerMonitor(this._docker);
    this.registry = new RegistryManager(this._docker, this.registryCredentialService);
    this.projectMgr = new ProjectManager(this._docker);
    this.infraMgr = new InfrastructureManager(this._docker);
    this.longRunningMgr = new LongRunningContainerManager(this._docker, this.labelManager);
  }

  /**
   * Initialize Docker client with current settings
   */
  public async initialize(): Promise<void> {
    try {
      // Get Docker configuration from database settings
      const dockerHost = await this.dockerConfigService.get("host");
      const apiVersion = await this.dockerConfigService.get("apiVersion");

      if (!dockerHost) {
        throw new Error("Docker host not configured in database settings");
      }

      this.docker = this.createDockerClient(dockerHost, apiVersion);

      // Test connection
      await this._docker.ping();
      servicesLogger().info("DockerExecutor initialized successfully");
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to initialize DockerExecutor",
      );
      throw error;
    }
  }

  /**
   * Create Docker client with specified configuration.
   * Delegates to DockerClientFactory but kept on the facade for backward compatibility.
   */
  private createDockerClient(host: string, apiVersion?: string | null): Docker {
    return this.clientFactory.createDockerClient(host, apiVersion);
  }

  // --- Utility ---
  public async getDockerNetworkName(): Promise<string> {
    return getDockerNetworkName();
  }

  // --- Container Execution ---
  public async executeContainer(options: ContainerExecutionOptions): Promise<ContainerExecutionResult> {
    return this.executor.executeContainer(options);
  }

  public async executeContainerWithProgress(
    options: ContainerExecutionOptions,
    progressCallback?: (progress: ContainerProgress) => void,
  ): Promise<ContainerExecutionResult> {
    return this.executor.executeContainerWithProgress(options, progressCallback);
  }

  // --- Container Monitoring ---
  public async getContainerStatus(containerId: string): Promise<{
    status: string;
    running: boolean;
    exitCode?: number;
  }> {
    return this.monitor.getContainerStatus(containerId);
  }

  public async stopContainer(containerId: string, forceKill = false): Promise<void> {
    return this.monitor.stopContainer(containerId, forceKill);
  }

  public async captureContainerLogs(
    containerId: string,
    options?: { tail?: number; since?: string; includeTimestamps?: boolean }
  ): Promise<{ stdout: string; stderr: string }> {
    return this.monitor.captureContainerLogs(containerId, options);
  }

  // --- Registry Operations ---
  public async pullImageWithAuth(
    image: string,
    registryUsername?: string,
    registryPassword?: string,
  ): Promise<void> {
    return this.registry.pullImageWithAuth(image, registryUsername, registryPassword);
  }

  public async pullImageWithAutoAuth(image: string): Promise<void> {
    return this.registry.pullImageWithAutoAuth(image);
  }

  public async testDockerRegistryConnection(
    options: DockerRegistryTestOptions,
  ): Promise<DockerRegistryTestResult> {
    return this.registry.testDockerRegistryConnection(options);
  }

  public async testDockerRegistryCredentialsFast(
    options: DockerRegistryTestOptions,
  ): Promise<DockerRegistryTestResult> {
    return this.registry.testDockerRegistryCredentialsFast(options);
  }

  // --- Project Management ---
  public async getProjectContainers(projectName: string): Promise<Docker.ContainerInfo[]> {
    return this.projectMgr.getProjectContainers(projectName);
  }

  public async getServiceContainers(projectName: string, serviceName: string): Promise<Docker.ContainerInfo[]> {
    return this.projectMgr.getServiceContainers(projectName, serviceName);
  }

  public async getManagedContainers(): Promise<Docker.ContainerInfo[]> {
    return this.projectMgr.getManagedContainers();
  }

  public async stopProject(projectName: string): Promise<void> {
    return this.projectMgr.stopProject(projectName);
  }

  public async removeProject(projectName: string): Promise<void> {
    return this.projectMgr.removeProject(projectName);
  }

  // --- Infrastructure ---
  public async createNetwork(
    networkName: string,
    projectName?: string,
    options?: { driver?: string; labels?: Record<string, string> }
  ): Promise<void> {
    return this.infraMgr.createNetwork(networkName, projectName, options);
  }

  public async createVolume(
    volumeName: string,
    projectName?: string,
    options?: { labels?: Record<string, string> }
  ): Promise<void> {
    return this.infraMgr.createVolume(volumeName, projectName, options);
  }

  public async networkExists(networkName: string): Promise<boolean> {
    return this.infraMgr.networkExists(networkName);
  }

  public async volumeExists(volumeName: string): Promise<boolean> {
    return this.infraMgr.volumeExists(volumeName);
  }

  public async removeVolume(volumeName: string): Promise<void> {
    return this.infraMgr.removeVolume(volumeName);
  }

  public async removeNetwork(networkName: string): Promise<void> {
    return this.infraMgr.removeNetwork(networkName);
  }

  // --- Long-Running Containers ---
  public async createLongRunningContainer(
    options: ContainerExecutionOptions & {
      name?: string;
      ports?: Record<string, { HostPort: string }[]>;
      internalPorts?: string[];
      volumes?: string[];
      mounts?: Array<{
        Target: string;
        Source: string;
        Type: 'volume' | 'bind';
        ReadOnly?: boolean;
      }>;
      networks?: string[];
      restartPolicy?: 'no' | 'on-failure' | 'unless-stopped' | 'always';
      healthcheck?: {
        Test: string[];
        Interval?: number;
        Timeout?: number;
        Retries?: number;
        StartPeriod?: number;
      };
      logConfig?: {
        Type: string;
        Config: Record<string, string>;
      };
      user?: string;
      entrypoint?: string[];
    }
  ): Promise<Container> {
    return this.longRunningMgr.createLongRunningContainer(options);
  }

  // --- Docker Client Access ---
  public getDockerClient(): Docker {
    return this._docker;
  }
}
