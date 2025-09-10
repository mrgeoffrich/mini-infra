import { DockerExecutorService } from '../docker-executor';
import { servicesLogger } from '../../lib/logger-factory';

export class HAProxyService {
  private dockerExecutor: DockerExecutorService;
  private readonly projectName: string;
  private readonly composeFile: string;
  private readonly logger = servicesLogger();

  constructor(projectName: string = 'haproxy', composeFile: string = 'docker-compose.haproxy.yml') {
    this.dockerExecutor = new DockerExecutorService();
    this.projectName = projectName;
    this.composeFile = composeFile;
  }

  /**
   * Initialize the HAProxy service
   */
  async initialize(): Promise<void> {
    await this.dockerExecutor.initialize();
  }

  async deployHAProxy(): Promise<void> {
    try {
      // Create network first
      await this.createNetwork();

      // Create named volumes
      await this.createVolumes();

      // Deploy haproxy-init container first
      await this.deployInitContainer();

      // Wait for init container to complete
      await this.waitForInitCompletion();

      // Deploy main haproxy container
      await this.deployHAProxyContainer();

      this.logger.info('HAProxy deployment completed successfully');
    } catch (error) {
      this.logger.error({ error }, 'Failed to deploy HAProxy');
      throw error;
    }
  }

  private async createNetwork(): Promise<void> {
    await this.dockerExecutor.createNetwork('haproxy_network', this.projectName, {
      driver: 'bridge'
    });
  }

  private async createVolumes(): Promise<void> {
    const volumes = ['haproxy_data', 'haproxy_run', 'haproxy_config'];

    for (const volumeName of volumes) {
      await this.dockerExecutor.createVolume(volumeName, this.projectName);
    }
  }

  private async deployInitContainer(): Promise<void> {
    // Pull image first
    await this.dockerExecutor.pullImageWithAuth('haproxytech/haproxy-alpine:3.2');

    const container = await this.dockerExecutor.createLongRunningContainer({
      image: 'haproxytech/haproxy-alpine:3.2',
      name: 'haproxy-init',
      projectName: this.projectName,
      serviceName: 'haproxy-init',
      env: {},
      cmd: [
        'sh',
        '-c',
        'cp /tmp/haproxy.cfg /usr/local/etc/haproxy/haproxy.cfg && cp /tmp/dataplaneapi.yml /usr/local/etc/haproxy/dataplaneapi.yml && chmod 666 /usr/local/etc/haproxy/dataplaneapi.yml && chmod 666 /usr/local/etc/haproxy/haproxy.cfg'
      ],
      volumes: [
        `${process.cwd()}/docker-compose/haproxy/dataplaneapi.yml:/tmp/dataplaneapi.yml:ro`,
        `${process.cwd()}/docker-compose/haproxy/haproxy.cfg:/tmp/haproxy.cfg:ro`
      ],
      mounts: [
        {
          Target: '/usr/local/etc/haproxy/',
          Source: 'haproxy_config',
          Type: 'volume'
        }
      ]
    });

    await container.start();
    this.logger.info('Started haproxy-init container');
  }

  private async waitForInitCompletion(): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();
    const container = docker.getContainer('haproxy-init');

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

    const container = await this.dockerExecutor.createLongRunningContainer({
      image: 'haproxytech/haproxy-alpine:3.2',
      name: 'haproxy',
      projectName: this.projectName,
      serviceName: 'haproxy',
      env: {
        'HAPROXY_DATACENTER': 'docker',
        'HAPROXY_MWORKER': '1',
        'DATAPLANEAPI_USERLIST_FILE': '/usr/local/etc/haproxy/haproxy.cfg'
      },
      ports: {
        '80/tcp': [{ HostPort: '8111' }],
        '443/tcp': [{ HostPort: '8443' }],
        '8404/tcp': [{ HostPort: '8404' }],
        '5555/tcp': [{ HostPort: '5555' }]
      },
      volumes: [
        `${process.cwd()}/docker-compose/haproxy/certs:/etc/ssl/certs:rw`
      ],
      mounts: [
        {
          Target: '/usr/local/etc/haproxy/',
          Source: 'haproxy_config',
          Type: 'volume'
        }
      ],
      networks: ['haproxy_network'],
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

  async removeHAProxy(): Promise<void> {
    try {
      // Stop and remove all containers in the project
      await this.dockerExecutor.removeProject(this.projectName);

      // Optionally remove network and volumes
      // await this.removeNetwork('haproxy_network');
      // await this.removeVolumes(['haproxy_data', 'haproxy_run', 'haproxy_config']);

      this.logger.info('HAProxy cleanup completed');
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
}