import { PrismaClient } from '@prisma/client';
import { loadbalancerLogger } from '../../lib/logger-factory';
import { HAProxyDataPlaneClient } from './haproxy-dataplane-client';
import { haproxyCertificateDeployer } from './haproxy-certificate-deployer';
import { haproxyRemediationService } from './haproxy-remediation-service';
import DockerService from '../docker';

const logger = loadbalancerLogger();

export interface PostApplyStep {
  step: string;
  status: 'completed' | 'failed' | 'skipped';
  detail?: string;
}

export interface PostApplyResult {
  success: boolean;
  steps: PostApplyStep[];
  errors: string[];
}

/**
 * After a fresh HAProxy container is created (via stack apply or migration),
 * restore runtime state from the database: TLS certificates, backends/servers,
 * and shared frontend routes.
 */
export async function restoreHAProxyRuntimeState(
  environmentId: string,
  prisma: PrismaClient
): Promise<PostApplyResult> {
  const steps: PostApplyStep[] = [];
  const errors: string[] = [];

  logger.info({ environmentId }, 'Restoring HAProxy runtime state from DB');

  let haproxyClient: HAProxyDataPlaneClient;
  try {
    haproxyClient = await getStackHAProxyClient(environmentId, prisma);
  } catch (error) {
    const msg = `Failed to connect to HAProxy container: ${error}`;
    logger.error({ error, environmentId }, msg);
    return { success: false, steps: [], errors: [msg] };
  }

  // Step 1: Redeploy TLS certificates
  const certIds = await getEnvironmentCertificateIds(environmentId, prisma);
  if (certIds.length > 0) {
    try {
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
      const msg = `Certificate deployment failed: ${error}`;
      logger.error({ error }, msg);
      errors.push(msg);
      steps.push({ step: 'Redeploy TLS certificates', status: 'failed', detail: msg });
    }
  } else {
    steps.push({ step: 'Redeploy TLS certificates', status: 'skipped', detail: 'No certificates to deploy' });
  }

  // Step 2: Recreate backends and servers from DB records
  try {
    const { backendsCreated, serversAdded } = await recreateBackendsAndServers(
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

  // Step 3: Run frontend remediation (shared frontends + routes)
  try {
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

  const success = errors.length === 0;
  logger.info(
    { environmentId, success, stepCount: steps.length, errorCount: errors.length },
    'HAProxy runtime state restoration completed'
  );

  return { success, steps, errors };
}

/**
 * Get all unique TLS certificate IDs associated with an environment.
 */
export async function getEnvironmentCertificateIds(
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
 * Recreate all active backends and their servers from DB records.
 */
export async function recreateBackendsAndServers(
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
 * Get HAProxy DataPlane client for the stack-managed container in an environment.
 * Retries initialization to allow time for the DataPlane API to become ready
 * after a fresh container is created.
 */
async function getStackHAProxyClient(
  environmentId: string,
  prisma: PrismaClient
): Promise<HAProxyDataPlaneClient> {
  const dockerService = DockerService.getInstance();
  await dockerService.initialize();
  const containers = await dockerService.listContainers();

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
    throw new Error('Stack-managed HAProxy container not found or not running');
  }

  const maxRetries = 5;
  const baseDelay = 3000;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const client = new HAProxyDataPlaneClient();
      await client.initialize(stackContainer.id);
      return client;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(1.5, attempt);
        logger.info(
          { attempt: attempt + 1, maxRetries, delay, environmentId },
          'DataPlane API not ready yet, retrying...'
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}
