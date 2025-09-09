import Docker from 'dockerode';
import { logger } from '../lib/logger';

export class HAProxyService {
  private docker: Docker;

  constructor() {
    this.docker = new Docker();
  }

  async deployHAProxy(): Promise<void> {
    const log = logger.child({ service: 'haproxy-service' });
    
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
      
      log.info('HAProxy deployment completed successfully');
    } catch (error) {
      log.error({ error }, 'Failed to deploy HAProxy');
      throw error;
    }
  }

  private async createNetwork(): Promise<void> {
    const log = logger.child({ operation: 'create-network' });
    
    try {
      const networks = await this.docker.listNetworks();
      const existingNetwork = networks.find(net => net.Name === 'haproxy_network');
      
      if (!existingNetwork) {
        await this.docker.createNetwork({
          Name: 'haproxy_network',
          Driver: 'bridge'
        });
        log.info('Created haproxy_network');
      } else {
        log.info('Network haproxy_network already exists');
      }
    } catch (error) {
      log.error({ error }, 'Failed to create network');
      throw error;
    }
  }

  private async createVolumes(): Promise<void> {
    const volumes = ['haproxy_data', 'haproxy_run', 'haproxy_config'];
    
    for (const volumeName of volumes) {
      try {
        const existingVolumes = await this.docker.listVolumes();
        const volumeExists = existingVolumes.Volumes?.some(vol => vol.Name === volumeName);
        
        if (!volumeExists) {
          await this.docker.createVolume({ Name: volumeName });
          logger.info({ volume: volumeName }, 'Created volume');
        }
      } catch (error) {
        logger.error({ error, volume: volumeName }, 'Failed to create volume');
        throw error;
      }
    }
  }

  private async deployInitContainer(): Promise<void> {
    const log = logger.child({ container: 'haproxy-init' });
    
    // Pull image first
    await this.pullImage('haproxytech/haproxy-alpine:3.2');
    
    const container = await this.docker.createContainer({
      Image: 'haproxytech/haproxy-alpine:3.2',
      name: 'haproxy-init',
      Cmd: [
        'sh',
        '-c',
        'cp /tmp/haproxy.cfg /usr/local/etc/haproxy/haproxy.cfg && cp /tmp/dataplaneapi.yml /usr/local/etc/haproxy/dataplaneapi.yml && chmod 666 /usr/local/etc/haproxy/dataplaneapi.yml && chmod 666 /usr/local/etc/haproxy/haproxy.cfg'
      ],
      HostConfig: {
        Binds: [
          `${process.cwd()}/docker-compose/haproxy/dataplaneapi.yml:/tmp/dataplaneapi.yml:ro`,
          `${process.cwd()}/docker-compose/haproxy/haproxy.cfg:/tmp/haproxy.cfg:ro`
        ],
        Mounts: [
          {
            Target: '/usr/local/etc/haproxy/',
            Source: 'haproxy_config',
            Type: 'volume'
          }
        ]
      }
    });

    await container.start();
    log.info('Started haproxy-init container');
  }

  private async waitForInitCompletion(): Promise<void> {
    const log = logger.child({ operation: 'wait-init' });
    const container = this.docker.getContainer('haproxy-init');
    
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
              log.info('Init container completed successfully');
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
    const log = logger.child({ container: 'haproxy' });
    
    await this.pullImage('haproxytech/haproxy-alpine:3.2');
    
    const container = await this.docker.createContainer({
      Image: 'haproxytech/haproxy-alpine:3.2',
      name: 'haproxy',
      Env: [
        'HAPROXY_DATACENTER=docker',
        'HAPROXY_MWORKER=1',
        'DATAPLANEAPI_USERLIST_FILE=/usr/local/etc/haproxy/haproxy.cfg'
      ],
      HostConfig: {
        PortBindings: {
          '80/tcp': [{ HostPort: '8111' }],
          '443/tcp': [{ HostPort: '8443' }],
          '8404/tcp': [{ HostPort: '8404' }],
          '5555/tcp': [{ HostPort: '5555' }]
        },
        Binds: [
          `${process.cwd()}/docker-compose/haproxy/certs:/etc/ssl/certs:rw`
        ],
        Mounts: [
          {
            Target: '/usr/local/etc/haproxy/',
            Source: 'haproxy_config',
            Type: 'volume'
          }
        ],
        RestartPolicy: {
          Name: 'unless-stopped'
        },
        LogConfig: {
          Type: 'json-file',
          Config: {
            'max-size': '10m',
            'max-file': '3'
          }
        }
      },
      NetworkingConfig: {
        EndpointsConfig: {
          haproxy_network: {}
        }
      },
      Healthcheck: {
        Test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:8404/stats'],
        Interval: 30000000000, // 30s in nanoseconds
        Timeout: 5000000000,   // 5s in nanoseconds
        Retries: 3,
        StartPeriod: 10000000000 // 10s in nanoseconds
      }
    });

    await container.start();
    log.info('Started haproxy container');
  }

  private async pullImage(image: string): Promise<void> {
    const log = logger.child({ image });
    
    try {
      log.info('Pulling image...');
      const stream = await this.docker.pull(image);
      
      return new Promise((resolve, reject) => {
        this.docker.modem.followProgress(stream, (err, res) => {
          if (err) {
            log.error({ error: err }, 'Failed to pull image');
            reject(err);
          } else {
            log.info('Image pulled successfully');
            resolve();
          }
        });
      });
    } catch (error) {
      log.error({ error }, 'Error pulling image');
      throw error;
    }
  }

  async removeHAProxy(): Promise<void> {
    const log = logger.child({ operation: 'cleanup' });
    
    try {
      // Stop and remove containers
      await this.removeContainer('haproxy');
      await this.removeContainer('haproxy-init');
      
      // Optionally remove network and volumes
      // await this.removeNetwork('haproxy_network');
      // await this.removeVolumes(['haproxy_data', 'haproxy_run', 'haproxy_config']);
      
      log.info('HAProxy cleanup completed');
    } catch (error) {
      log.error({ error }, 'Failed to cleanup HAProxy');
      throw error;
    }
  }

  private async removeContainer(containerName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      
      if (info.State.Running) {
        await container.stop();
      }
      
      await container.remove();
      logger.info({ container: containerName }, 'Removed container');
    } catch (error) {
      if ((error as any).statusCode === 404) {
        logger.info({ container: containerName }, 'Container not found, skipping removal');
      } else {
        throw error;
      }
    }
  }
}