import { DockerExecutorService } from '../docker-executor';
import {
  StackInitCommand,
  StackConfigFile,
  StackServiceDefinition,
} from '@mini-infra/types';
import { getLogger } from '../../lib/logger-factory';
import { groupByProperty } from './utils';
import type { PrismaClient } from '../../generated/prisma/client';

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

  constructor(private dockerExecutor: DockerExecutorService, private prisma: PrismaClient) {}

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
    const containerId = await this.createContainer(serviceName, service, options);
    await this.startContainer(containerId);
    return containerId;
  }

  /**
   * Create a container without starting it. Use this when you need to attach
   * additional networks (e.g. joinNetworks, joinResourceNetworks) BEFORE the
   * container's PID 1 starts running — otherwise the container's bootstrap
   * code can race a synchronous DNS lookup against networks that haven't
   * been hot-attached yet (e.g. vault, applications).
   *
   * Pair with {@link startContainer} once all networks are joined.
   */
  async createContainer(
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
      // Phase 2 egress: mark bypass services so EnvFirewallManager can filter
      // them out via Docker events (avoids adding them to the managed ipset).
      // Note: we do NOT imperatively call EnvFirewallManager.addManagedContainer()
      // here — the manager subscribes to Docker events instead, which is more
      // robust (catches restarts and manual docker start/stop operations).
      ...(config.egressBypass === true ? { 'mini-infra.egress.bypass': 'true' } : {}),
      ...(config.labels ?? {}),
    };

    this.log.info({ containerName, image }, 'Creating container');

    const egressResult = await this.resolveEgressInjection(service, options);
    const egressEnv = egressResult.type === 'proxy' ? egressResult.env : {};

    const container = await this.dockerExecutor.createLongRunningContainer({
      image,
      name: containerName,
      projectName: options.projectName,
      serviceName,
      env: { ...egressEnv, ...(config.env ?? {}) },
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

    return container.id;
  }

  /**
   * Start a previously-created container. Pair with {@link createContainer}
   * after all required networks are attached.
   */
  async startContainer(containerId: string): Promise<void> {
    const docker = this.dockerExecutor.getDockerClient();
    await docker.getContainer(containerId).start();
    this.log.info({ containerId }, 'Container started');
  }

  /**
   * Resolve what egress injection to apply for a managed container.
   *
   * Gates (in order):
   * - Host-level stack (no environmentId) → no injection.
   * - Service has egressBypass === true → no injection (egress-gateway itself, fw-agent, etc.)
   * - Environment has no egressGatewayIp → no injection (gateway not provisioned).
   *
   * When the env has been provisioned with an egress-gateway, inject
   * HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars pointing at the
   * egress-gateway container via Docker DNS alias `egress-gateway:3128`.
   * Docker's default 127.0.0.11 resolver remains in place for DNS.
   *
   * Note: `egressFirewallEnabled` is intentionally not consulted here. That
   * flag gates whether the fw-agent actively enforces policies, not which
   * gateway is provisioned. `egressGatewayIp` (set once at env creation by
   * provisionEgressGateway) is the canonical "gateway exists" signal.
   *
   * Never throws — egress injection failure must not break stack apply.
   */
  private async resolveEgressInjection(
    service: StackServiceDefinition,
    options: CreateContainerOptions,
  ): Promise<{ type: 'none' } | { type: 'proxy'; env: Record<string, string> }> {
    if (!options.environmentId) {
      return { type: 'none' };
    }

    if (service.containerConfig.egressBypass === true) {
      return { type: 'none' };
    }

    try {
      const environment = await this.prisma.environment.findUnique({
        where: { id: options.environmentId },
        select: { egressGatewayIp: true },
      });

      if (!environment?.egressGatewayIp) {
        this.log.warn(
          { environmentId: options.environmentId, stackId: options.stackId },
          'Environment has no egressGatewayIp — skipping egress injection',
        );
        return { type: 'none' };
      }

      const proxyUrl = 'http://egress-gateway:3128';
      const bridgeCidr = await this.resolveApplicationsBridgeCidr(options.environmentId);
      const noProxy = ['localhost', '127.0.0.0/8', ...(bridgeCidr ? [bridgeCidr] : [])].join(',');

      return {
        type: 'proxy',
        env: {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY: noProxy,
          no_proxy: noProxy,
        },
      };
    } catch (err) {
      this.log.warn(
        { environmentId: options.environmentId, stackId: options.stackId, error: err },
        'Error resolving egress injection — skipping to not block stack apply',
      );
      return { type: 'none' };
    }
  }

  /**
   * Resolve the CIDR of the applications bridge for the given environment.
   * Used to populate NO_PROXY so managed containers bypass the proxy for
   * intra-env traffic (e.g., container-to-container, container-to-gateway).
   *
   * Returns null when the bridge CIDR is not yet known (e.g., network not yet
   * created). The caller omits it from NO_PROXY in that case.
   */
  private async resolveApplicationsBridgeCidr(environmentId: string): Promise<string | null> {
    try {
      const resource = await this.prisma.infraResource.findFirst({
        where: {
          type: 'docker-network',
          purpose: 'applications',
          scope: 'environment',
          environmentId,
        },
        select: { metadata: true },
      });
      const meta = resource?.metadata as Record<string, unknown> | null;
      const subnet = meta?.['subnet'];
      if (typeof subnet === 'string') {
        return subnet;
      }
    } catch (err) {
      this.log.warn(
        { environmentId, error: err },
        'Could not resolve applications bridge CIDR for NO_PROXY',
      );
    }
    return null;
  }

  async connectToNetwork(containerId: string, networkName: string, aliases?: string[]): Promise<void> {
    this.log.info({ containerId, networkName, aliases }, 'Connecting container to network');
    const docker = this.dockerExecutor.getDockerClient();
    const network = docker.getNetwork(networkName);
    await network.connect({
      Container: containerId,
      ...(aliases && aliases.length > 0
        ? { EndpointConfig: { Aliases: aliases } }
        : {}),
    });
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
      // No healthcheck — observe the container for a short window to catch
      // "started, then immediately crashed" cases (e.g. invalid Slack token
      // → auth.test fails → container exits non-zero within seconds). The
      // previous one-shot inspect would return true if the container hadn't
      // exited yet, leaving the stack as `synced` with a dead service.
      // First, the initial inspect already tells us if the container has
      // exited fast enough that the apply itself was racing it; short-circuit.
      if (info.State?.Status === 'exited' || info.State?.Status === 'dead') {
        return false;
      }
      return this.observeStableRunning(containerId, NO_HEALTHCHECK_OBSERVE_MS);
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
      // If the container exited mid-startup (before the healthcheck could
      // finish), don't keep polling for a state that will never come.
      if (inspectResult.State?.Status === 'exited' || inspectResult.State?.Status === 'dead') {
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    return false;
  }

  /**
   * Watch a just-started container for a short window and confirm it stays
   * running. Returns false if the container is no longer running at any
   * point during the window. Used when a container has no Docker
   * healthcheck — without this, a service that crashes seconds after start
   * looks "applied successfully" because Docker briefly reports it as
   * `running` before the exit.
   */
  private async observeStableRunning(containerId: string, observeMs: number): Promise<boolean> {
    const start = Date.now();
    // Initial check — if it's not running at t=0, no point polling.
    const initial = await this.dockerExecutor.getContainerStatus(containerId);
    if (!initial.running) return false;

    while (Date.now() - start < observeMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await this.dockerExecutor.getContainerStatus(containerId);
      if (!status.running) return false;
    }
    return true;
  }

  /**
   * Capture exit info + recent logs for a container that just failed its
   * apply-time health/stability check. Designed to enrich the
   * ServiceApplyResult error and the Stack.lastFailureReason summary so the
   * operator can see why apply rejected the service without `docker logs`.
   * All lookups are best-effort — failures here must never break the apply
   * pipeline.
   */
  async captureContainerFailureInfo(
    containerId: string,
  ): Promise<{ exitCode?: number; status?: string; tailLogs?: string }> {
    let exitCode: number | undefined;
    let status: string | undefined;
    let tailLogs: string | undefined;

    try {
      const s = await this.dockerExecutor.getContainerStatus(containerId);
      status = s.status;
      // exitCode === 0 with status === 'exited' is unusual but valid; only
      // surface non-zero codes since 0 is the success signal.
      if (s.exitCode !== undefined && s.exitCode !== 0) {
        exitCode = s.exitCode;
      }
    } catch {
      // status lookup failed — fall through, still try logs
    }

    try {
      const logs = await this.dockerExecutor.captureContainerLogs(containerId, { tail: 10 });
      const merged = [logs.stderr, logs.stdout]
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .join('\n');
      if (merged.length > 0) {
        tailLogs = merged;
      }
    } catch {
      // log capture failed — that's fine, we'll just omit it
    }

    return { exitCode, status, tailLogs };
  }
}

/**
 * How long we observe a container without a Docker healthcheck before
 * declaring it "started successfully". Long enough to catch the typical
 * "crashed within a few seconds of unwrapping a vault token / failing
 * auth.test" pattern; short enough not to noticeably slow apply.
 *
 * Skipped under NODE_ENV=test so the unit suite isn't paying 5s per apply
 * — tests that need to exercise the observation path do so explicitly via
 * the integration suite (real Docker daemon) or by mocking
 * `getContainerStatus` to return a non-running state on first poll.
 */
const NO_HEALTHCHECK_OBSERVE_MS = process.env.NODE_ENV === 'test' ? 0 : 5000;
