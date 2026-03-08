import { PrismaClient } from '@prisma/client';
import { loadbalancerLogger } from '../../lib/logger-factory';
import { DockerExecutorService } from '../docker-executor';
import { StackReconciler } from '../stacks/stack-reconciler';
import DockerService from '../docker';
import {
  restoreHAProxyRuntimeState,
  getEnvironmentCertificateIds,
} from './haproxy-post-apply';

const logger = loadbalancerLogger();

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
    await dockerExecutor.initialize();
    const existingVolumes: string[] = [];
    for (const vol of legacyVolumeNames) {
      if (await dockerExecutor.volumeExists(vol)) {
        existingVolumes.push(vol);
      }
    }

    // 4. Count certificates that need redeployment
    const certIds = await getEnvironmentCertificateIds(environmentId, prisma);

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
    prisma: PrismaClient,
    onStep?: (step: MigrationStep, completedCount: number, totalSteps: number) => void,
  ): Promise<MigrationResult> {
    const steps: MigrationStep[] = [];
    const errors: string[] = [];
    // Estimate total steps: remove container + volumes + apply stack + restore state + update record
    // We refine this as we discover more (e.g. postApply steps), but start with a reasonable estimate.
    let totalSteps = 5;

    const emitStep = (step: MigrationStep) => {
      steps.push(step);
      if (step.status === 'failed') errors.push(step.detail ?? step.step);
      try { onStep?.(step, steps.length, totalSteps); } catch { /* never break migration */ }
    };

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

    // Pre-flight: verify the haproxy stack definition exists BEFORE any destructive action
    const haproxyStack = await prisma.stack.findFirst({
      where: { name: 'haproxy', environmentId },
    });
    if (!haproxyStack) {
      const msg = 'HAProxy stack definition not found for this environment. Run server restart to sync built-in stacks.';
      logger.error({ environmentId }, msg);
      return {
        success: false,
        steps: [{ step: 'Pre-flight: verify stack exists', status: 'failed', detail: msg }],
        errors: [msg],
      };
    }

    // Refine total step count now that we know the preview
    // remove container (1) + remove volumes (N) + apply stack (1) + restore state (~3) + update record (1)
    totalSteps = 1 + preview.legacyVolumes.length + 1 + 3 + 1;

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
      emitStep({ step: 'Remove legacy container', status: 'completed', detail: preview.legacyContainer!.name });
    } catch (error) {
      const msg = `Failed to remove legacy container: ${error}`;
      logger.error({ error, environmentId }, msg);
      emitStep({ step: 'Remove legacy container', status: 'failed', detail: msg });
      return { success: false, steps, errors };
    }

    // Step 2: Remove legacy volumes
    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    for (const vol of preview.legacyVolumes) {
      try {
        await dockerExecutor.removeVolume(vol);
        emitStep({ step: 'Remove legacy volume', status: 'completed', detail: vol });
      } catch (error) {
        const msg = `Failed to remove volume ${vol}: ${error}`;
        logger.warn({ error, volume: vol }, msg);
        emitStep({ step: 'Remove legacy volume', status: 'failed', detail: msg });
        // Non-fatal: continue even if a volume can't be removed
      }
    }

    // Step 3: Apply haproxy stack (pre-validated above)
    try {
      logger.info({ stackId: haproxyStack.id }, 'Applying haproxy stack');
      const reconciler = new StackReconciler(dockerExecutor, prisma);
      const result = await reconciler.apply(haproxyStack.id);
      emitStep({
        step: 'Apply haproxy stack',
        status: 'completed',
        detail: `Stack applied: ${result.serviceResults.map((s: { serviceName: string; action: string }) => `${s.serviceName}=${s.action}`).join(', ')}`,
      });
    } catch (error) {
      const msg = `Failed to apply haproxy stack: ${error}`;
      logger.error({ error, stackId: haproxyStack.id }, msg);
      emitStep({ step: 'Apply haproxy stack', status: 'failed', detail: msg });
      return { success: false, steps, errors };
    }

    // Steps 4-6: Restore runtime state (TLS certificates, backends/servers, frontend remediation)
    const postApply = await restoreHAProxyRuntimeState(environmentId, prisma);
    // Update totalSteps to reflect actual post-apply steps
    totalSteps = 1 + preview.legacyVolumes.length + 1 + postApply.steps.length + 1;
    for (const postStep of postApply.steps) {
      emitStep(postStep);
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
        emitStep({ step: 'Update legacy service record', status: 'completed', detail: 'Marked as migrated-to-stack' });
      }
    } catch (error) {
      const msg = `Failed to update EnvironmentService record: ${error}`;
      logger.warn({ error }, msg);
      emitStep({ step: 'Update legacy service record', status: 'failed', detail: msg });
    }

    const success = errors.length === 0;
    logger.info({ environmentId, success, stepCount: steps.length, errorCount: errors.length }, 'HAProxy migration completed');

    return { success, steps, errors };
  }

}

export const haproxyMigrationService = new HAProxyMigrationService();
