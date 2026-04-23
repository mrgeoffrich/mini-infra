import { DockerExecutorService } from '../docker-executor';
import {
  StackInitCommand,
  StackConfigFile,
  StackServiceDefinition,
} from '@mini-infra/types';
import { getLogger } from '../../lib/logger-factory';
import { groupByProperty } from './utils';

export interface CreateContainerOptions {
  projectName: string;
  stackId: string;
  stackName: string;
  stackVersion: number;
  environmentId?: string | null;
  definitionHash: string;
  networkNames: string[];
}

export class StackContainerManager {
  private log = getLogger("stacks", "stack-container-manager").child({ component: 'stack-container-manager' });

  constructor(private dockerExecutor: DockerExecutorService) {}

  async pullImage(image: string, tag: string): Promise<void> {
    this.log.info({ image, tag }, 'Pulling image');
    await this.dockerExecutor.pullImageWithAutoAuth(`${image}:${tag}`);
  }

  async runInitCommands(initCommands: StackInitCommand[], projectName: string): Promise<void> {
    const byVolume = groupByProperty(initCommands, 'volumeName');

    for (const [volumeName, commands] of byVolume) {
      const prefixedVolume = `${projectName}_${volumeName}`;
      const allCommands = commands.flatMap((c) => c.commands);
      const mountPath = commands[0].mountPath;
      if (!/^\/[a-zA-Z0-9_./-]*$/.test(mountPath)) {
        throw new Error(`Invalid mountPath: ${mountPath}`);
      }
      const shellCmd = allCommands.join(' && ');
      const containerName = `${projectName}-init-${volumeName}-${Date.now()}`;

      this.log.info({ volumeName: prefixedVolume, containerName, commandCount: allCommands.length }, 'Running init commands');
      await this.runEphemeralContainer(containerName, shellCmd, `${prefixedVolume}:${mountPath}`);
      this.log.info({ containerName }, 'Init commands completed');
    }
  }

  async writeConfigFiles(configFiles: StackConfigFile[], projectName: string): Promise<void> {
    const byVolume = groupByProperty(configFiles, 'volumeName');

    for (const [volumeName, files] of byVolume) {
      const prefixedVolume = `${projectName}_${volumeName}`;
      const containerName = `${projectName}-config-writer-${volumeName}-${Date.now()}`;

      // Build shell commands for all files in this volume
      const volPath = (p: string) => `/vol${p.startsWith('/') ? '' : '/'}${p}`;
      const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const dirs = [...new Set(files.map((f) => volPath(f.path).substring(0, volPath(f.path).lastIndexOf('/'))))].filter(Boolean);
      const parts: string[] = [];

      if (dirs.length > 0) {
        parts.push(`mkdir -p ${dirs.map(shellQuote).join(' ')}`);
      }

      for (const file of files) {
        const dest = shellQuote(volPath(file.path));
        const escapedContent = file.content.replace(/'/g, "'\\''");
        parts.push(`echo '${escapedContent}' > ${dest}`);
        if (file.permissions) {
          if (!/^[0-7]{3,4}$/.test(file.permissions)) {
            throw new Error(`Invalid permissions value: ${file.permissions}`);
          }
          parts.push(`chmod ${file.permissions} ${dest}`);
        }
        if (file.ownerUid !== undefined || file.ownerGid !== undefined) {
          const uid = file.ownerUid ?? 0;
          const gid = file.ownerGid ?? 0;
          parts.push(`chown ${uid}:${gid} ${dest}`);
        }
      }

      const shellCmd = parts.join(' && ');

      this.log.info({ volumeName: prefixedVolume, containerName, fileCount: files.length }, 'Writing config files');
      await this.runEphemeralContainer(containerName, shellCmd, `${prefixedVolume}:/vol`);
      this.log.info({ containerName }, 'Config files written');
    }
  }

  private async runEphemeralContainer(name: string, shellCmd: string, bind: string): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();
    const container = await docker.createContainer({
      Image: 'alpine:latest',
      name,
      Cmd: ['sh', '-c', shellCmd],
      HostConfig: { Binds: [bind] },
    });

    try {
      await container.start();
      await container.wait();
    } finally {
      try {
        await container.remove({ force: true });
      } catch (err) {
        this.log.warn({ containerName: name, error: err }, 'Failed to remove ephemeral container');
      }
    }
  }

  async createAndStartContainer(
    serviceName: string,
    service: StackServiceDefinition,
    options: CreateContainerOptions
  ): Promise<string> {
    const containerName = `${options.projectName}-${serviceName}`;
    const image = `${service.dockerImage}:${service.dockerTag}`;
    const config = service.containerConfig;

    // Convert ports to Docker format
    // hostPort 0 means no exposure at all; exposeOnHost false means expose internally only (no host binding)
    const hostBoundPorts = config.ports?.filter((p) => p.hostPort !== 0 && p.exposeOnHost !== false);
    const internalOnlyPorts = config.ports?.filter((p) => p.exposeOnHost === false && p.hostPort !== 0);

    const ports: Record<string, { HostPort: string }[]> | undefined =
      hostBoundPorts && hostBoundPorts.length > 0
        ? Object.fromEntries(
            hostBoundPorts.map((p) => [
              `${p.containerPort}/${p.protocol}`,
              [{ HostPort: String(p.hostPort) }],
            ])
          )
        : undefined;

    // Ports to expose on the container without host binding (for internal network access)
    const internalPorts =
      internalOnlyPorts && internalOnlyPorts.length > 0
        ? internalOnlyPorts.map((p) => `${p.containerPort}/${p.protocol}`)
        : undefined;

    // Convert mounts to Docker format, prefixing volume sources with projectName
    const mounts = config.mounts?.map((m) => ({
      Target: m.target,
      Source: m.type === 'volume' && !m.source.includes('/') ? `${options.projectName}_${m.source}` : m.source,
      Type: m.type,
      ReadOnly: m.readOnly,
    }));

    // Convert healthcheck seconds to nanoseconds. By this point template
    // references like "{{params.x}}" have been resolved to numbers, so
    // Number() is a narrowing cast, not a parse.
    const healthcheck = config.healthcheck
      ? {
          Test: config.healthcheck.test,
          Interval: Number(config.healthcheck.interval) * 1_000_000_000,
          Timeout: Number(config.healthcheck.timeout) * 1_000_000_000,
          Retries: Number(config.healthcheck.retries),
          StartPeriod: Number(config.healthcheck.startPeriod) * 1_000_000_000,
        }
      : undefined;

    // Convert log config
    const logConfig = config.logConfig
      ? {
          Type: config.logConfig.type,
          Config: { 'max-size': config.logConfig.maxSize, 'max-file': config.logConfig.maxFile },
        }
      : undefined;

    // Stack-specific labels
    const labels: Record<string, string> = {
      'mini-infra.stack': options.stackName,
      'mini-infra.stack-id': options.stackId,
      'mini-infra.service': serviceName,
      ...(options.environmentId ? { 'mini-infra.environment': options.environmentId } : {}),
      'mini-infra.definition-hash': options.definitionHash,
      'mini-infra.stack-version': options.stackVersion.toString(),
      ...(config.labels ?? {}),
    };

    this.log.info({ containerName, image }, 'Creating container');

    const container = await this.dockerExecutor.createLongRunningContainer({
      image,
      name: containerName,
      projectName: options.projectName,
      serviceName,
      env: config.env ?? {},
      cmd: config.command,
      entrypoint: config.entrypoint,
      capAdd: config.capAdd,
      user: config.user,
      ports,
      internalPorts,
      mounts,
      networks: options.networkNames,
      restartPolicy: config.restartPolicy,
      healthcheck,
      logConfig,
      labels,
    });

    await container.start();
    this.log.info({ containerId: container.id, containerName }, 'Container started');

    return container.id;
  }

  async connectToNetwork(containerId: string, networkName: string): Promise<void> {
    this.log.info({ containerId, networkName }, 'Connecting container to network');
    const docker = this.dockerExecutor.getDockerClient();
    const network = docker.getNetwork(networkName);
    await network.connect({ Container: containerId });
  }

  async stopAndRemoveContainer(containerId: string): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();
    const container = docker.getContainer(containerId);

    try {
      await container.stop();
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode !== 404 && statusCode !== 304) {
        throw err;
      }
    }

    try {
      await container.remove({ force: true });
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode !== 404) {
        throw err;
      }
    }
  }

  async waitForHealthy(containerId: string, timeoutMs = 60_000): Promise<boolean> {
    const docker = this.dockerExecutor.getDockerClient();
    const container = docker.getContainer(containerId);

    // Check if container has a healthcheck configured
    const info = await container.inspect();

    const hcTest = info.Config?.Healthcheck?.Test;
    if (!hcTest || hcTest.length === 0 || (hcTest.length === 1 && hcTest[0] === 'NONE')) {
      // No healthcheck or HEALTHCHECK NONE — just verify the container is running
      const status = await this.dockerExecutor.getContainerStatus(containerId);
      return status.running;
    }

    // Poll for healthy status
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const inspectResult = await container.inspect();
      const healthStatus = inspectResult.State?.Health?.Status;

      if (healthStatus === 'healthy') {
        return true;
      }
      if (healthStatus === 'unhealthy') {
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    return false;
  }
}
