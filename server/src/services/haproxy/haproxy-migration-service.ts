import { PrismaClient } from '@prisma/client';
import { loadbalancerLogger } from '../../lib/logger-factory';
import { DockerExecutorService } from '../docker-executor';
import { StackReconciler } from '../stacks/stack-reconciler';
import { HAProxyDataPlaneClient } from './haproxy-dataplane-client';
import { haproxyRemediationService } from './haproxy-remediation-service';
import { haproxyCertificateDeployer } from './haproxy-certificate-deployer';
import DockerService from '../docker';

const logger = loadbalancerLogger();

/** Legacy resource names for an environment */
interface LegacyResources {
  containerName: string;
  containerId: string | null;
  volumes: string[];
  existingVolumes: string[];
}

export interface MigrationPreview {
  needsMigration: boolean;
  /** Legacy HAProxy container found (not stack-managed) */
  legacyContainer: {
    name: string;
    id: string;
    status: string;
  } | null;
  /** Stack record for this environment */
  stackStatus: {
    id: string;
    name: string;
    status: string;
  } | null;
  /** Legacy volumes that will be removed */
  legacyVolumes: string[];
  /** Certificates that will be redeployed */
  certificateCount: number;
  /** Backends that will be recreated */
  backendCount: number;
  /** Servers that will be re-added to backends */
  serverCount: number;
  /** What happens after migration */
  postMigration: {
    newContainerName: string;
    newVolumes: string[];
    networkReused: string;
    remediationNeeded: boolean;
  };
}

export interface MigrationResult {
  success: boolean;
  steps: MigrationStep[];
  errors: string[];
}

export interface MigrationStep {
  step: string;
  status: 'completed' | 'failed' | 'skipped';
  detail?: string;
}

export class HAProxyMigrationService {
  /**
   * Detect whether an environment has a legacy (non-stack-managed) HAProxy container.
   */
  async getMigrationPreview(
    environmentId: string,
    prisma: PrismaClient
  ): Promise<MigrationPreview> {
    logger.info({ environmentId }, 'Computing migration preview');

    const environment = await prisma.environment.findUniqueOrThrow({
      where: { id: environmentId },
      include: { services: true },
    });

    const envName = environment.name;

    // 1. Find the haproxy stack for this environment
    const haproxyStack = await prisma.stack.findFirst({
      where: { name: 'haproxy', environmentId },
    });

    // 2. Look for a running HAProxy container
    const dockerService = DockerService.getInstance();
    await dockerService.initialize();
    const containers = await dockerService.listContainers();

    // A legacy container has mini-infra.service=haproxy but NO mini-infra.stack-id label
    const legacyContainer = containers.find((c: any) => {
      const labels = c.labels || {};
      return (
        labels['mini-infra.service'] === 'haproxy' &&
        labels['mini-infra.environment'] === environmentId &&
        !labels['mini-infra.stack-id']
      );
    });

    // Also check if there's already a stack-managed container
    const stackContainer = containers.find((c: any) => {
      const labels = c.labels || {};
      return (
        labels['mini-infra.service'] === 'haproxy' &&
        labels['mini-infra.environment'] === environmentId &&
        !!labels['mini-infra.stack-id']
      );
    });

    // If there's already a stack-managed container, no migration needed
    if (stackContainer || !legacyContainer) {
      return {
        needsMigration: false,
        legacyContainer: null,
        stackStatus: haproxyStack
          ? { id: haproxyStack.id, name: haproxyStack.name, status: haproxyStack.status }
          : null,
        legacyVolumes: [],
        certificateCount: 0,
        backendCount: 0,
        serverCount: 0,
        postMigration: {
          newContainerName: `${envName}-haproxy-haproxy`,
          newVolumes: [],
          networkReused: `${envName}-haproxy_network`,
          remediationNeeded: false,
        },
      };
    }

    // 3. Check which legacy volumes exist
    const legacyVolumeNames = [
      `${envName}-haproxy_config`,
      `${envName}-haproxy_data`,
      `${envName}-haproxy_run`,
      `${envName}-haproxy_certs`,
    ];

    const dockerExecutor = new DockerExecutorService();
    const existingVolumes: string[] = [];
    for (const vol of legacyVolumeNames) {
      if (await dockerExecutor.volumeExists(vol)) {
        existingVolumes.push(vol);
      }
    }

    // 4. Count certificates that need redeployment
    const certIds = await this.getEnvironmentCertificateIds(environmentId, prisma);

    // 5. Count backends and servers that need recreation
    const activeBackends = await prisma.hAProxyBackend.findMany({
      where: { environmentId, status: 'active' },
      include: { servers: { where: { status: 'active' }, select: { id: true } } },
    });
    const backendCount = activeBackends.length;
    const serverCount = activeBackends.reduce((sum, b) => sum + b.servers.length, 0);

    // 6. Check if remediation will be needed after migration
    const deploymentConfigs = await prisma.deploymentConfiguration.findMany({
      where: { environmentId, isActive: true, hostname: { not: null } },
      select: { id: true },
    });
    const legacyFrontends = await prisma.hAProxyFrontend.findMany({
      where: { environmentId, status: { not: 'removed' }, isSharedFrontend: false },
      select: { id: true },
    });

    // New stack volume names
    const newVolumes = [
      `${envName}-haproxy_haproxy_config`,
      `${envName}-haproxy_haproxy_data`,
      `${envName}-haproxy_haproxy_run`,
      `${envName}-haproxy_haproxy_certs`,
    ];

    return {
      needsMigration: true,
      legacyContainer: {
        name: (legacyContainer as any).name || `${envName}-haproxy`,
        id: legacyContainer.id,
        status: legacyContainer.status,
      },
      stackStatus: haproxyStack
        ? { id: haproxyStack.id, name: haproxyStack.name, status: haproxyStack.status }
        : null,
      legacyVolumes: existingVolumes,
      certificateCount: certIds.length,
      backendCount,
      serverCount,
      postMigration: {
        newContainerName: `${envName}-haproxy-haproxy`,
        newVolumes,
        networkReused: `${envName}-haproxy_network`,
        remediationNeeded: legacyFrontends.length > 0 || deploymentConfigs.length > 0,
      },
    };
  }

  /**
   * Execute the full migration from legacy HAProxy to stack-managed HAProxy.
   *
   * Steps:
   * 1. Stop & remove legacy container
   * 2. Remove legacy volumes
   * 3. Apply haproxy stack (creates new container, volumes, config)
   * 4. Redeploy TLS certificates
   * 5. Run frontend remediation (shared frontends + routes)
   * 6. Clean up EnvironmentService record
   */
  async migrate(
    environmentId: string,
    prisma: PrismaClient
  ): Promise<MigrationResult> {
    const steps: MigrationStep[] = [];
    const errors: string[] = [];

    logger.info({ environmentId }, 'Starting HAProxy migration to stack management');

    const environment = await prisma.environment.findUniqueOrThrow({
      where: { id: environmentId },
      include: { services: true },
    });
    const envName = environment.name;

    // Verify migration is needed
    const preview = await this.getMigrationPreview(environmentId, prisma);
    if (!preview.needsMigration) {
      return {
        success: true,
        steps: [{ step: 'Check migration needed', status: 'skipped', detail: 'Already stack-managed' }],
        errors: [],
      };
    }

    // Step 1: Stop & remove legacy container
    try {
      logger.info({ containerId: preview.legacyContainer!.id }, 'Stopping legacy HAProxy container');
      const dockerService = DockerService.getInstance();
      const docker = await dockerService.getDockerInstance();
      const container = docker.getContainer(preview.legacyContainer!.id);
      try {
        await container.stop({ t: 10 });
      } catch (err: any) {
        // Container might already be stopped
        if (!err.message?.includes('not running') && !err.message?.includes('304')) {
          throw err;
        }
      }
      await container.remove({ force: true });
      steps.push({ step: 'Remove legacy container', status: 'completed', detail: preview.legacyContainer!.name });
    } catch (error) {
      const msg = `Failed to remove legacy container: ${error}`;
      logger.error({ error, environmentId }, msg);
      errors.push(msg);
      steps.push({ step: 'Remove legacy container', status: 'failed', detail: msg });
      return { success: false, steps, errors };
    }

    // Step 2: Remove legacy volumes
    const dockerExecutor = new DockerExecutorService();
    for (const vol of preview.legacyVolumes) {
      try {
        await dockerExecutor.removeVolume(vol);
        steps.push({ step: 'Remove legacy volume', status: 'completed', detail: vol });
      } catch (error) {
        const msg = `Failed to remove volume ${vol}: ${error}`;
        logger.warn({ error, volume: vol }, msg);
        errors.push(msg);
        steps.push({ step: 'Remove legacy volume', status: 'failed', detail: msg });
        // Non-fatal: continue even if a volume can't be removed
      }
    }

    // Step 3: Apply haproxy stack
    const haproxyStack = await prisma.stack.findFirst({
      where: { name: 'haproxy', environmentId },
    });

    if (!haproxyStack) {
      const msg = 'HAProxy stack definition not found for this environment. Run server restart to sync built-in stacks.';
      errors.push(msg);
      steps.push({ step: 'Apply haproxy stack', status: 'failed', detail: msg });
      return { success: false, steps, errors };
    }

    try {
      logger.info({ stackId: haproxyStack.id }, 'Applying haproxy stack');
      const reconciler = new StackReconciler(dockerExecutor, prisma);
      const result = await reconciler.apply(haproxyStack.id);
      steps.push({
        step: 'Apply haproxy stack',
        status: 'completed',
        detail: `Stack applied: ${result.serviceResults.map((s: { serviceName: string; action: string }) => `${s.serviceName}=${s.action}`).join(', ')}`,
      });
    } catch (error) {
      const msg = `Failed to apply haproxy stack: ${error}`;
      logger.error({ error, stackId: haproxyStack.id }, msg);
      errors.push(msg);
      steps.push({ step: 'Apply haproxy stack', status: 'failed', detail: msg });
      return { success: false, steps, errors };
    }

    // Step 4: Redeploy TLS certificates
    const certIds = await this.getEnvironmentCertificateIds(environmentId, prisma);
    if (certIds.length > 0) {
      try {
        // Need to get HAProxy client for the new container
        const haproxyClient = await this.getNewHAProxyClient(environmentId, prisma);

        let deployedCount = 0;
        for (const certId of certIds) {
          try {
            const fileName = await haproxyCertificateDeployer.fetchAndDeployCertificate(
              certId,
              prisma,
              haproxyClient,
              { gracefulNotFound: true }
            );
            if (fileName) {
              deployedCount++;
            }
          } catch (error) {
            const msg = `Failed to deploy certificate ${certId}: ${error}`;
            logger.warn({ error, certId }, msg);
            errors.push(msg);
          }
        }

        steps.push({
          step: 'Redeploy TLS certificates',
          status: deployedCount > 0 ? 'completed' : 'skipped',
          detail: `${deployedCount}/${certIds.length} certificates deployed`,
        });
      } catch (error) {
        const msg = `Failed to connect to new HAProxy for certificate deployment: ${error}`;
        logger.error({ error }, msg);
        errors.push(msg);
        steps.push({ step: 'Redeploy TLS certificates', status: 'failed', detail: msg });
        // Non-fatal: continue to remediation
      }
    } else {
      steps.push({ step: 'Redeploy TLS certificates', status: 'skipped', detail: 'No certificates to deploy' });
    }

    // Step 5: Recreate backends and servers from DB records
    try {
      const haproxyClient = await this.getNewHAProxyClient(environmentId, prisma);
      const { backendsCreated, serversAdded } = await this.recreateBackendsAndServers(
        environmentId,
        haproxyClient,
        prisma
      );

      steps.push({
        step: 'Recreate backends and servers',
        status: backendsCreated > 0 || serversAdded > 0 ? 'completed' : 'skipped',
        detail: `${backendsCreated} backend(s), ${serversAdded} server(s)`,
      });
    } catch (error) {
      const msg = `Failed to recreate backends and servers: ${error}`;
      logger.error({ error }, msg);
      errors.push(msg);
      steps.push({ step: 'Recreate backends and servers', status: 'failed', detail: msg });
    }

    // Step 6: Run frontend remediation
    if (preview.postMigration.remediationNeeded) {
      try {
        const haproxyClient = await this.getNewHAProxyClient(environmentId, prisma);
        const remediationResult = await haproxyRemediationService.remediateEnvironment(
          environmentId,
          haproxyClient,
          prisma
        );

        steps.push({
          step: 'Frontend remediation',
          status: remediationResult.success ? 'completed' : 'failed',
          detail: `Frontends: +${remediationResult.frontendsCreated}/-${remediationResult.frontendsDeleted}, Routes: ${remediationResult.routesConfigured}`,
        });

        if (!remediationResult.success) {
          errors.push(...remediationResult.errors);
        }
      } catch (error) {
        const msg = `Frontend remediation failed: ${error}`;
        logger.error({ error }, msg);
        errors.push(msg);
        steps.push({ step: 'Frontend remediation', status: 'failed', detail: msg });
      }
    } else {
      steps.push({ step: 'Frontend remediation', status: 'skipped', detail: 'No remediation needed' });
    }

    // Step 7: Mark legacy EnvironmentService as migrated
    try {
      const haproxyEnvService = environment.services.find(
        (s) => s.serviceName === 'haproxy' || s.serviceType === 'haproxy'
      );
      if (haproxyEnvService) {
        await prisma.environmentService.update({
          where: { id: haproxyEnvService.id },
          data: { status: 'migrated-to-stack' },
        });
        steps.push({ step: 'Update legacy service record', status: 'completed', detail: 'Marked as migrated-to-stack' });
      }
    } catch (error) {
      const msg = `Failed to update EnvironmentService record: ${error}`;
      logger.warn({ error }, msg);
      errors.push(msg);
      steps.push({ step: 'Update legacy service record', status: 'failed', detail: msg });
    }

    const success = errors.length === 0;
    logger.info({ environmentId, success, stepCount: steps.length, errorCount: errors.length }, 'HAProxy migration completed');

    return { success, steps, errors };
  }

  /**
   * Recreate all active backends and their servers from DB records.
   * This restores the HAProxy runtime configuration after a fresh container start.
   */
  private async recreateBackendsAndServers(
    environmentId: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<{ backendsCreated: number; serversAdded: number }> {
    let backendsCreated = 0;
    let serversAdded = 0;

    const backends = await prisma.hAProxyBackend.findMany({
      where: { environmentId, status: 'active' },
      include: { servers: { where: { status: 'active' } } },
    });

    logger.info(
      { environmentId, backendCount: backends.length },
      'Recreating backends and servers from DB'
    );

    for (const backend of backends) {
      try {
        // Check if backend already exists in HAProxy (shouldn't on fresh container)
        const existing = await haproxyClient.getBackend(backend.name);
        if (!existing) {
          await haproxyClient.createBackend({
            name: backend.name,
            mode: backend.mode as 'http' | 'tcp',
            balance: backend.balanceAlgorithm as 'roundrobin' | 'leastconn' | 'source',
            ...(backend.checkTimeout && { check_timeout: backend.checkTimeout }),
            ...(backend.connectTimeout && { connect_timeout: backend.connectTimeout }),
            ...(backend.serverTimeout && { server_timeout: backend.serverTimeout }),
          });
          backendsCreated++;
        }

        // Add servers to the backend
        for (const server of backend.servers) {
          try {
            await haproxyClient.addServer(backend.name, {
              name: server.name,
              address: server.address,
              port: server.port,
              check: server.check as 'enabled' | 'disabled',
              ...(server.checkPath && { check_path: server.checkPath }),
              ...(server.inter && { inter: server.inter }),
              ...(server.rise && { rise: server.rise }),
              ...(server.fall && { fall: server.fall }),
              weight: server.weight,
              maintenance: server.maintenance ? 'enabled' : 'disabled',
              enabled: server.enabled,
            });
            serversAdded++;
          } catch (error) {
            logger.warn(
              { error, backendName: backend.name, serverName: server.name },
              'Failed to add server to backend'
            );
          }
        }

        logger.info(
          { backendName: backend.name, serverCount: backend.servers.length },
          'Recreated backend with servers'
        );
      } catch (error) {
        logger.error(
          { error, backendName: backend.name },
          'Failed to recreate backend'
        );
      }
    }

    return { backendsCreated, serversAdded };
  }

  /**
   * Get all unique TLS certificate IDs associated with an environment.
   */
  private async getEnvironmentCertificateIds(
    environmentId: string,
    prisma: PrismaClient
  ): Promise<string[]> {
    const [deploymentCerts, frontendCerts, routeCerts] = await Promise.all([
      prisma.deploymentConfiguration.findMany({
        where: { environmentId, isActive: true, tlsCertificateId: { not: null } },
        select: { tlsCertificateId: true },
      }),
      prisma.hAProxyFrontend.findMany({
        where: { environmentId, status: { not: 'removed' }, tlsCertificateId: { not: null } },
        select: { tlsCertificateId: true },
      }),
      prisma.hAProxyRoute.findMany({
        where: {
          sharedFrontend: { environmentId },
          status: 'active',
          tlsCertificateId: { not: null },
        },
        select: { tlsCertificateId: true },
      }),
    ]);

    const allCertIds = new Set<string>();
    for (const r of [...deploymentCerts, ...frontendCerts, ...routeCerts]) {
      if (r.tlsCertificateId) allCertIds.add(r.tlsCertificateId);
    }
    return [...allCertIds];
  }

  /**
   * Get HAProxy DataPlane client for the newly created stack-managed container.
   */
  private async getNewHAProxyClient(
    environmentId: string,
    prisma: PrismaClient
  ): Promise<HAProxyDataPlaneClient> {
    const dockerService = DockerService.getInstance();
    await dockerService.initialize();
    const containers = await dockerService.listContainers();

    // Find the stack-managed HAProxy container
    const stackContainer = containers.find((c: any) => {
      const labels = c.labels || {};
      return (
        labels['mini-infra.service'] === 'haproxy' &&
        labels['mini-infra.environment'] === environmentId &&
        !!labels['mini-infra.stack-id'] &&
        c.status === 'running'
      );
    });

    if (!stackContainer) {
      throw new Error('New stack-managed HAProxy container not found or not running');
    }

    const client = new HAProxyDataPlaneClient();
    await client.initialize(stackContainer.id);
    return client;
  }
}

export const haproxyMigrationService = new HAProxyMigrationService();
