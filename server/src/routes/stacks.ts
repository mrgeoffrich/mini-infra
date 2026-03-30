import { Router } from 'express';
import prisma from '../lib/prisma';
import { appLogger } from '../lib/logger-factory';
import { requirePermission } from '../middleware/auth';
import { DockerExecutorService } from '../services/docker-executor';
import { StackReconciler } from '../services/stacks/stack-reconciler';
import { StackResourceReconciler } from '../services/stacks/stack-resource-reconciler';
import { StackRoutingManager } from '../services/stacks/stack-routing-manager';
import { HAProxyFrontendManager } from '../services/haproxy';
import { restoreHAProxyRuntimeState } from '../services/haproxy/haproxy-post-apply';
import { MonitoringService } from '../services/monitoring';
import { CertificateLifecycleManager } from '../services/tls/certificate-lifecycle-manager';
import { AcmeClientManager } from '../services/tls/acme-client-manager';
import { AzureStorageCertificateStore } from '../services/tls/azure-storage-certificate-store';
import { DnsChallenge01Provider } from '../services/tls/dns-challenge-provider';
import { CertificateDistributor } from '../services/tls/certificate-distributor';
import { CloudflareDNSService } from '../services/cloudflare/cloudflare-dns';
import { CloudflareService } from '../services/cloudflare';
import { HaproxyCertificateDeployer } from '../services/haproxy/haproxy-certificate-deployer';
import { TlsConfigService } from '../services/tls/tls-config';
import { AzureStorageService } from '../services/azure-storage-service';
import { HAProxyService } from '../services/haproxy/haproxy-service';
import {
  createStackSchema,
  updateStackSchema,
  updateStackServiceSchema,
  applyStackSchema,
} from '../services/stacks/schemas';
import {
  serializeStack,
  toServiceCreateInput,
  isDockerConnectionError,
  mapContainerStatus,
} from '../services/stacks/utils';
import { Channel, ServerEvent, StackParameterDefinition, StackParameterValue } from '@mini-infra/types';
import { emitToChannel } from '../lib/socket';
import { mergeParameterValues } from '../services/stacks/utils';

const router = Router();
const logger = appLogger();

/** Track in-progress stack applies to prevent concurrent operations */
const applyingStacks = new Set<string>();

/**
 * Create a StackResourceReconciler with all required dependencies.
 * Initializes TLS lifecycle manager (ACME client, Azure storage, DNS challenge provider)
 * along with Cloudflare DNS and HAProxy certificate deployer services.
 */
async function createResourceReconciler(): Promise<StackResourceReconciler> {
  const tlsConfig = new TlsConfigService(prisma);
  const azureConfig = new AzureStorageService(prisma);

  const containerName = await tlsConfig.getCertificateContainerName();
  const connectionString = await azureConfig.getConnectionString();

  let certLifecycleManager: CertificateLifecycleManager | undefined;
  const cloudflareConfig = new CloudflareService(prisma);

  if (connectionString) {
    const certificateStore = new AzureStorageCertificateStore(connectionString, containerName);
    const acmeClient = new AcmeClientManager(tlsConfig, certificateStore);
    const dnsChallenge = new DnsChallenge01Provider(cloudflareConfig);

    await acmeClient.initialize();

    const haproxyService = new HAProxyService();
    const dockerExec = new DockerExecutorService();
    await dockerExec.initialize();
    const distributor = new CertificateDistributor(certificateStore, haproxyService, dockerExec);

    certLifecycleManager = new CertificateLifecycleManager(
      acmeClient,
      certificateStore,
      dnsChallenge,
      prisma,
      containerName,
      distributor,
    );
  }

  // If Azure storage isn't configured, create a proxy that throws a descriptive
  // error when TLS provisioning is actually attempted.
  const effectiveCertManager: CertificateLifecycleManager = certLifecycleManager ?? ({
    issueCertificate: () => { throw new Error('TLS provisioning requires Azure Storage configuration'); },
    renewCertificate: () => { throw new Error('TLS provisioning requires Azure Storage configuration'); },
    revokeCertificate: () => { throw new Error('TLS provisioning requires Azure Storage configuration'); },
  } as unknown as CertificateLifecycleManager);

  return new StackResourceReconciler(
    prisma,
    effectiveCertManager,
    new CloudflareDNSService(),
    new HaproxyCertificateDeployer(),
    cloudflareConfig,
  );
}

// GET / — List stacks
router.get('/', requirePermission('stacks:read'), async (req, res) => {
  try {
    const { environmentId, scope, source } = req.query;
    const where: any = { status: { not: 'removed' } };
    if (scope === 'host') {
      where.environmentId = null;
    } else if (environmentId && typeof environmentId === 'string') {
      where.environmentId = environmentId;
    }

    // Filter by template source if specified
    if (source === 'user') {
      where.template = { source: 'user' };
    } else if (source === 'system') {
      where.OR = [
        { template: { source: 'system' } },
        { templateId: null },
      ];
    } else if (scope === 'host' || environmentId) {
      // When listing for host/environment, exclude user stacks by default
      where.OR = [
        { template: { source: 'system' } },
        { templateId: null },
      ];
    }

    const stacks = await prisma.stack.findMany({
      where,
      include: {
        services: true,
        template: { select: { source: true, currentVersion: { select: { version: true } } } },
      },
      orderBy: { name: 'asc' },
    });

    res.json({ success: true, data: stacks.map(serializeStack) });
  } catch (error) {
    logger.error({ error }, 'Failed to list stacks');
    res.status(500).json({ success: false, message: 'Failed to list stacks' });
  }
});

// GET /:stackId — Get stack with services
router.get('/:stackId', requirePermission('stacks:read'), async (req, res) => {
  try {
    const stack = await prisma.stack.findUnique({
      where: { id: String(req.params.stackId) },
      include: {
        services: { orderBy: { order: 'asc' } },
        template: { select: { currentVersion: { select: { version: true } } } },
      },
    });

    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    res.json({ success: true, data: serializeStack(stack) });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to get stack');
    res.status(500).json({ success: false, message: 'Failed to get stack' });
  }
});

// POST / — Create stack
router.post('/', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = createStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const { name, description, environmentId, parameters, parameterValues, networks, volumes, services, tlsCertificates, dnsRecords, tunnelIngress } = parsed.data;

    if (environmentId) {
      // Check environment exists
      const environment = await prisma.environment.findUnique({ where: { id: environmentId } });
      if (!environment) {
        return res.status(404).json({ success: false, message: 'Environment not found' });
      }

      // Check uniqueness within environment (exclude removed stacks)
      const existing = await prisma.stack.findFirst({ where: { name, environmentId, status: { not: 'removed' } } });
      if (existing) {
        return res.status(409).json({ success: false, message: 'A stack with this name already exists in this environment' });
      }
    } else {
      // Host-level stack: enforce singleton (exclude removed stacks)
      const existing = await prisma.stack.findFirst({ where: { name, environmentId: null, status: { not: 'removed' } } });
      if (existing) {
        return res.status(409).json({ success: false, message: 'A host-level stack with this name already exists' });
      }
    }

    const stack = await prisma.stack.create({
      data: {
        name,
        description: description ?? null,
        environmentId: environmentId ?? undefined,
        parameters: parameters ? (parameters as any) : undefined,
        parameterValues: parameterValues ? (parameterValues as any) : undefined,
        networks: networks as any,
        volumes: volumes as any,
        tlsCertificates: tlsCertificates ?? [],
        dnsRecords: dnsRecords ?? [],
        tunnelIngress: tunnelIngress ?? [],
        services: {
          create: (services as any[]).map(toServiceCreateInput),
        },
      },
      include: { services: true },
    });

    logger.info({ stackId: stack.id, stackName: stack.name }, 'Stack created');
    res.status(201).json({ success: true, data: serializeStack(stack) });
  } catch (error) {
    logger.error({ error }, 'Failed to create stack');
    res.status(500).json({ success: false, message: 'Failed to create stack' });
  }
});

// PUT /:stackId — Update stack definition
router.put('/:stackId', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = updateStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const stackId = String(req.params.stackId);
    const existing = await prisma.stack.findUnique({
      where: { id: stackId },
      include: { services: true },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const { services, parameters, parameterValues, tlsCertificates, dnsRecords, tunnelIngress, ...fields } = parsed.data;

    const updateData: any = {
      ...fields,
      networks: fields.networks ? (fields.networks as any) : undefined,
      volumes: fields.volumes ? (fields.volumes as any) : undefined,
      parameters: parameters ? (parameters as any) : undefined,
      parameterValues: parameterValues ? (parameterValues as any) : undefined,
      ...(tlsCertificates !== undefined ? { tlsCertificates } : {}),
      ...(dnsRecords !== undefined ? { dnsRecords } : {}),
      ...(tunnelIngress !== undefined ? { tunnelIngress } : {}),
      version: existing.version + 1,
      status: 'pending',
    };

    if (services) {
      // Transaction: delete existing services, update stack, recreate services
      const stack = await prisma.$transaction(async (tx) => {
        await tx.stackService.deleteMany({ where: { stackId } });

        return tx.stack.update({
          where: { id: stackId },
          data: {
            ...updateData,
            services: {
              create: (services as any[]).map(toServiceCreateInput),
            },
          },
          include: { services: true },
        });
      });

      res.json({ success: true, data: serializeStack(stack) });
    } else {
      const stack = await prisma.stack.update({
        where: { id: stackId },
        data: updateData,
        include: { services: true },
      });

      res.json({ success: true, data: serializeStack(stack) });
    }
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to update stack');
    res.status(500).json({ success: false, message: 'Failed to update stack' });
  }
});

// DELETE /:stackId — Delete stack
router.delete('/:stackId', requirePermission('stacks:write'), async (req, res) => {
  try {
    const stackId = String(req.params.stackId);
    const stack = await prisma.stack.findUnique({ where: { id: stackId } });

    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    if (stack.status !== 'undeployed' && stack.status !== 'pending') {
      // Check if there are running containers
      try {
        const dockerExecutor = new DockerExecutorService();
        await dockerExecutor.initialize();
        const docker = dockerExecutor.getDockerClient();
        const containers = await docker.listContainers({
          filters: { label: [`mini-infra.stack-id=${stackId}`] },
        });

        if (containers.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'Cannot delete stack with running containers. Remove containers first or set status to undeployed.',
          });
        }
      } catch {
        // If Docker is unavailable, be conservative
        return res.status(400).json({
          success: false,
          message: 'Cannot verify container state. Stack status must be "undeployed" to delete without Docker access.',
        });
      }
    }

    await prisma.stack.delete({ where: { id: stackId } });
    res.json({ success: true, message: 'Stack deleted' });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to delete stack');
    res.status(500).json({ success: false, message: 'Failed to delete stack' });
  }
});

// PUT /:stackId/services/:serviceName — Update single service
router.put('/:stackId/services/:serviceName', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = updateStackServiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const stackId = String(req.params.stackId); const serviceName = String(req.params.serviceName);

    const service = await prisma.stackService.findFirst({
      where: { stackId, serviceName },
    });

    if (!service) {
      return res.status(404).json({ success: false, message: 'Stack service not found' });
    }

    const updateData: any = {};
    const data = parsed.data;
    if (data.serviceType !== undefined) updateData.serviceType = data.serviceType;
    if (data.dockerImage !== undefined) updateData.dockerImage = data.dockerImage;
    if (data.dockerTag !== undefined) updateData.dockerTag = data.dockerTag;
    if (data.containerConfig !== undefined) updateData.containerConfig = data.containerConfig as any;
    if (data.configFiles !== undefined) updateData.configFiles = data.configFiles as any;
    if (data.initCommands !== undefined) updateData.initCommands = data.initCommands as any;
    if (data.dependsOn !== undefined) updateData.dependsOn = data.dependsOn;
    if (data.order !== undefined) updateData.order = data.order;
    if (data.routing !== undefined) updateData.routing = data.routing as any;

    await prisma.$transaction([
      prisma.stackService.update({
        where: { id: service.id },
        data: updateData,
      }),
      prisma.stack.update({
        where: { id: stackId },
        data: {
          version: { increment: 1 },
          status: 'pending',
        },
      }),
    ]);

    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      include: { services: { orderBy: { order: 'asc' } } },
    });

    res.json({ success: true, data: serializeStack(stack) });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId, serviceName: req.params.serviceName }, 'Failed to update stack service');
    res.status(500).json({ success: false, message: 'Failed to update stack service' });
  }
});

// GET /:stackId/plan — Compute plan
router.get('/:stackId/plan', requirePermission('stacks:read'), async (req, res) => {
  try {
    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    const resourceReconciler = await createResourceReconciler();
    const reconciler = new StackReconciler(dockerExecutor, prisma, undefined, resourceReconciler);
    const plan = await reconciler.plan(String(req.params.stackId));

    res.json({ success: true, data: plan });
  } catch (error: any) {
    if (isDockerConnectionError(error)) {
      return res.status(503).json({ success: false, message: 'Docker is unavailable' });
    }
    logger.error({ error, stackId: req.params.stackId }, 'Failed to compute plan');
    res.status(500).json({ success: false, message: error?.message ?? 'Failed to compute plan' });
  }
});

// GET /:stackId/validate — Validate stack parameters before apply
router.get('/:stackId/validate', requirePermission('stacks:read'), async (req, res) => {
  try {
    const stack = await prisma.stack.findUnique({
      where: { id: String(req.params.stackId) },
      select: { parameters: true, parameterValues: true },
    });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const paramDefs = (stack.parameters as unknown as StackParameterDefinition[]) ?? [];
    const paramValues = mergeParameterValues(
      paramDefs,
      (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
    );

    const errors: Array<{ name: string; description?: string; error: string }> = [];
    for (const def of paramDefs) {
      const value = paramValues[def.name];
      if (value === '' || value === undefined || value === null) {
        errors.push({ name: def.name, description: def.description, error: 'Parameter is required but has no value' });
      }
    }

    res.json({
      success: true,
      valid: errors.length === 0,
      errors,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message ?? 'Validation failed' });
  }
});

// POST /:stackId/apply — Apply changes (fire-and-forget with Socket.IO progress)
router.post('/:stackId/apply', requirePermission('stacks:write'), async (req, res) => {
  const stackId = String(req.params.stackId);
  try {
    const parsed = applyStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    // Prevent concurrent applies on the same stack
    if (applyingStacks.has(stackId)) {
      return res.status(409).json({ success: false, message: 'Stack apply already in progress' });
    }

    // Validate that all required parameters have non-empty values
    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      select: { parameters: true, parameterValues: true },
    });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const paramDefs = (stack.parameters as unknown as StackParameterDefinition[]) ?? [];
    const paramValues = mergeParameterValues(
      paramDefs,
      (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
    );
    const emptyParams = paramDefs.filter((def) => {
      const value = paramValues[def.name];
      return value === '' || value === undefined || value === null;
    });
    if (emptyParams.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Stack has parameters that are not configured',
        parameters: emptyParams.map((p) => ({ name: p.name, description: p.description })),
      });
    }

    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    const routingManager = new StackRoutingManager(prisma, new HAProxyFrontendManager());
    const resourceReconciler = await createResourceReconciler();
    const reconciler = new StackReconciler(dockerExecutor, prisma, routingManager, resourceReconciler);

    // Pre-compute plan so we can emit the started event with action details
    const plan = await reconciler.plan(stackId);
    const activeActions = plan.actions.filter((a) => a.action !== 'no-op');

    // Filter by serviceNames if provided
    let plannedActions = activeActions;
    if (parsed.data.serviceNames && parsed.data.serviceNames.length > 0) {
      const filterSet = new Set(parsed.data.serviceNames);
      plannedActions = activeActions.filter((a) => filterSet.has(a.serviceName));
    }

    // For forcePull, include all services since any could be promoted to recreate
    // after pulling new images. Mark them as "pull" initially.
    const isForcePull = !!parsed.data.forcePull;
    let startedActions: Array<{ serviceName: string; action: string }>;
    if (isForcePull && plannedActions.length === 0) {
      startedActions = plan.actions.map((a) => ({ serviceName: a.serviceName, action: 'pull' }));
    } else {
      startedActions = plannedActions.map((a) => ({ serviceName: a.serviceName, action: a.action }));
    }

    applyingStacks.add(stackId);

    // Emit started event
    emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_STARTED, {
      stackId,
      stackName: plan.stackName,
      totalActions: startedActions.length,
      actions: startedActions,
      forcePull: isForcePull,
    });

    // Respond immediately — progress comes via Socket.IO
    res.json({ success: true, data: { started: true, stackId } });

    // Run apply in background
    const triggeredBy = (req as any).user?.id;
    (async () => {
      try {
        const result = await reconciler.apply(stackId, {
          ...parsed.data,
          triggeredBy,
          plan,
          onProgress: (result, completedCount, totalActions) => {
            try {
              emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_SERVICE_RESULT, {
                stackId,
                ...result,
                completedCount,
                totalActions,
              } as any);
            } catch { /* never break apply */ }
          },
        });

        // HAProxy post-apply restoration
        let postApply: { success: boolean; errors?: string[] } | undefined;
        const haproxyServiceApplied = result.serviceResults.some(
          (r) => r.serviceName === 'haproxy' && r.success && (r.action === 'create' || r.action === 'recreate')
        );
        if (haproxyServiceApplied) {
          const stack = await prisma.stack.findUnique({
            where: { id: stackId },
            select: { name: true, environmentId: true },
          });
          if (stack?.name === 'haproxy' && stack.environmentId) {
            const postApplyResult = await restoreHAProxyRuntimeState(stack.environmentId, prisma);
            if (!postApplyResult.success) {
              logger.warn({ stackId, errors: postApplyResult.errors }, 'HAProxy post-apply restoration had errors');
            }
            postApply = { success: postApplyResult.success, errors: postApplyResult.errors };
          }
        }

        // Monitoring post-apply: connect app container to monitoring network
        if (result.success) {
          const stack = await prisma.stack.findUnique({
            where: { id: stackId },
            select: { name: true },
          });
          if (stack?.name === 'monitoring') {
            try {
              const monitoringService = new MonitoringService();
              await monitoringService.initialize();
              await monitoringService.ensureAppConnectedToMonitoringNetwork();
            } catch (err) {
              logger.warn({ error: err }, 'Failed to connect app to monitoring network after apply');
            }
          }
        }

        // Emit completed event
        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          ...result,
          postApply,
        });
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack apply failed');
        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          success: false,
          stackId,
          appliedVersion: 0,
          serviceResults: [],
          resourceResults: [],
          duration: 0,
          error: error.message,
        });
      } finally {
        applyingStacks.delete(stackId);
      }
    })();
  } catch (error: any) {
    applyingStacks.delete(stackId);
    if (isDockerConnectionError(error)) {
      return res.status(503).json({ success: false, message: 'Docker is unavailable' });
    }
    logger.error({ error, stackId }, 'Failed to start stack apply');
    res.status(500).json({ success: false, message: error?.message ?? 'Failed to apply stack' });
  }
});

// POST /:stackId/update — Pull latest images and redeploy changed containers
router.post('/:stackId/update', requirePermission('stacks:write'), async (req, res) => {
  const stackId = String(req.params.stackId);
  try {
    // Prevent concurrent operations on the same stack
    if (applyingStacks.has(stackId)) {
      return res.status(409).json({ success: false, message: 'Stack operation already in progress' });
    }

    // Validate stack exists and is deployed
    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      select: { id: true, name: true, status: true },
    });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }
    if (stack.status !== 'synced' && stack.status !== 'drifted') {
      return res.status(400).json({
        success: false,
        message: `Stack must be deployed to update (current status: ${stack.status})`,
      });
    }

    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    const routingManager = new StackRoutingManager(prisma, new HAProxyFrontendManager());
    const resourceReconciler = await createResourceReconciler();
    const reconciler = new StackReconciler(dockerExecutor, prisma, routingManager, resourceReconciler);

    applyingStacks.add(stackId);

    // Emit started event — use same STACK_APPLY events with action context
    const plan = await reconciler.plan(stackId);
    const startedActions = plan.actions.map((a) => ({ serviceName: a.serviceName, action: 'update' }));

    emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_STARTED, {
      stackId,
      stackName: plan.stackName,
      totalActions: startedActions.length,
      actions: startedActions,
      forcePull: true,
    });

    // Respond immediately
    res.json({ success: true, data: { started: true, stackId } });

    // Run update in background
    const triggeredBy = (req as any).user?.id;
    (async () => {
      try {
        const result = await reconciler.update(stackId, {
          triggeredBy,
          onProgress: (serviceResult, completedCount, totalActions) => {
            try {
              emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_SERVICE_RESULT, {
                stackId,
                ...serviceResult,
                completedCount,
                totalActions,
              } as any);
            } catch { /* never break update */ }
          },
        });

        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          ...result,
        });
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack update failed');
        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          success: false,
          stackId,
          appliedVersion: 0,
          serviceResults: [],
          resourceResults: [],
          duration: 0,
          error: error.message,
        });
      } finally {
        applyingStacks.delete(stackId);
      }
    })();
  } catch (error: any) {
    applyingStacks.delete(stackId);
    if (isDockerConnectionError(error)) {
      return res.status(503).json({ success: false, message: 'Docker is unavailable' });
    }
    logger.error({ error, stackId }, 'Failed to start stack update');
    res.status(500).json({ success: false, message: error?.message ?? 'Failed to update stack' });
  }
});

// POST /:stackId/destroy — Destroy stack: remove containers, networks, volumes, and DB record
router.post('/:stackId/destroy', requirePermission('stacks:write'), async (req, res) => {
  const stackId = String(req.params.stackId);
  try {
    const stack = await prisma.stack.findUnique({ where: { id: stackId } });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    // Prevent concurrent operations on the same stack
    if (applyingStacks.has(stackId)) {
      return res.status(409).json({ success: false, message: 'An operation is already in progress for this stack' });
    }
    applyingStacks.add(stackId);

    // Acknowledge immediately, run in background
    emitToChannel(Channel.STACKS, ServerEvent.STACK_DESTROY_STARTED, { stackId, stackName: stack.name });
    res.json({ success: true, data: { started: true, stackId } });

    const triggeredBy = (req as any).user?.id;
    (async () => {
      try {
        const dockerExecutor = new DockerExecutorService();
        await dockerExecutor.initialize();
        const resourceReconciler = await createResourceReconciler();
        const reconciler = new StackReconciler(dockerExecutor, prisma, undefined, resourceReconciler);
        const result = await reconciler.destroyStack(stackId, { triggeredBy });

        emitToChannel(Channel.STACKS, ServerEvent.STACK_DESTROY_COMPLETED, result);
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack destroy failed');
        emitToChannel(Channel.STACKS, ServerEvent.STACK_DESTROY_COMPLETED, {
          success: false,
          stackId,
          containersRemoved: 0,
          networksRemoved: [],
          volumesRemoved: [],
          duration: 0,
          error: error.message,
        });
      } finally {
        applyingStacks.delete(stackId);
      }
    })();
  } catch (error: any) {
    applyingStacks.delete(stackId);
    if (isDockerConnectionError(error)) {
      return res.status(503).json({ success: false, message: 'Docker is unavailable' });
    }
    logger.error({ error, stackId }, 'Failed to start stack destroy');
    res.status(500).json({ success: false, message: error?.message ?? 'Failed to destroy stack' });
  }
});

// GET /:stackId/status — Current status with container state
router.get('/:stackId/status', requirePermission('stacks:read'), async (req, res) => {
  try {
    const stackId = String(req.params.stackId);
    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      include: {
        services: { orderBy: { order: 'asc' } },
        template: { select: { currentVersion: { select: { version: true } } } },
      },
    });

    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    let containerStatus: any[] = [];
    try {
      const dockerExecutor = new DockerExecutorService();
      await dockerExecutor.initialize();
      const docker = dockerExecutor.getDockerClient();
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack-id=${stackId}`] },
      });

      containerStatus = containers.map((c) => ({
        ...mapContainerStatus(c),
        health: c.Labels['mini-infra.definition-hash'] ? 'tracked' : 'untracked',
      }));
    } catch {
      // Docker unavailable — return stack info without container status
    }

    res.json({
      success: true,
      data: {
        stack: serializeStack(stack),
        containerStatus,
      },
    });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to get stack status');
    res.status(500).json({ success: false, message: 'Failed to get stack status' });
  }
});

// GET /:stackId/history — List deployment history
router.get('/:stackId/history', requirePermission('stacks:read'), async (req, res) => {
  try {
    const stackId = String(req.params.stackId);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const stack = await prisma.stack.findUnique({ where: { id: stackId }, select: { id: true } });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const [data, total] = await Promise.all([
      prisma.stackDeployment.findMany({
        where: { stackId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.stackDeployment.count({ where: { stackId } }),
    ]);

    res.json({ success: true, data, total });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to get stack history');
    res.status(500).json({ success: false, message: 'Failed to get stack history' });
  }
});

// GET /:stackId/history/:deploymentId — Specific deployment record
router.get('/:stackId/history/:deploymentId', requirePermission('stacks:read'), async (req, res) => {
  try {
    const deployment = await prisma.stackDeployment.findFirst({
      where: { id: String(req.params.deploymentId), stackId: String(req.params.stackId) },
    });

    if (!deployment) {
      return res.status(404).json({ success: false, message: 'Deployment not found' });
    }

    res.json({ success: true, data: deployment });
  } catch (error) {
    logger.error({ error, stackId: req.params.stackId }, 'Failed to get deployment record');
    res.status(500).json({ success: false, message: 'Failed to get deployment record' });
  }
});

export default router;
