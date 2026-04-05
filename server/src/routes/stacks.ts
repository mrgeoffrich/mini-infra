import { Router } from 'express';
import { createActor } from 'xstate';
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
import { TlsConfigService } from '../services/tls/tls-config';
import { AzureStorageService } from '../services/azure-storage-service';
import { HAProxyService } from '../services/haproxy/haproxy-service';
import DockerService from '../services/docker';
import { EnvironmentValidationService } from '../services/environment';
import { removalDeploymentMachine } from '../services/haproxy/removal-deployment-state-machine';
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
import { Channel, ServerEvent, StackNetwork, StackVolume, StackParameterDefinition, StackParameterValue, ResourceResult, ResourceType, ServiceApplyResult } from '@mini-infra/types';
import { UserEventService } from '../services/user-events';
import {
  formatPlanStep,
  formatServiceStep,
  formatResourceGroupStep,
  formatDestroyResourceStep,
  formatDestroyContainerStep,
  formatDestroyNetworkStep,
  formatDestroyVolumeStep,
} from '../services/stacks/stack-event-log-formatter';
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

    const { name, description, environmentId, parameters, parameterValues, resourceOutputs, resourceInputs, networks, volumes, services, tlsCertificates, dnsRecords, tunnelIngress } = parsed.data;

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
        resourceOutputs: resourceOutputs ? (resourceOutputs as any) : undefined,
        resourceInputs: resourceInputs ? (resourceInputs as any) : undefined,
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

    const { services, parameters, parameterValues, resourceOutputs, resourceInputs, tlsCertificates, dnsRecords, tunnelIngress, ...fields } = parsed.data;

    const updateData: any = {
      ...fields,
      networks: fields.networks ? (fields.networks as any) : undefined,
      volumes: fields.volumes ? (fields.volumes as any) : undefined,
      parameters: parameters ? (parameters as any) : undefined,
      parameterValues: parameterValues ? (parameterValues as any) : undefined,
      ...(resourceOutputs !== undefined ? { resourceOutputs: resourceOutputs as any } : {}),
      ...(resourceInputs !== undefined ? { resourceInputs: resourceInputs as any } : {}),
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

    applyingStacks.add(stackId);

    // Respond immediately — planning and apply run in background
    res.json({ success: true, data: { started: true, stackId } });

    // Run planning + apply in background
    const triggeredBy = (req as any).user?.id;
    const userEventService = new UserEventService(prisma);
    const isForcePull = !!parsed.data.forcePull;

    (async () => {
      // Initialize services
      const dockerExecutor = new DockerExecutorService();
      await dockerExecutor.initialize();
      const routingManager = new StackRoutingManager(prisma, new HAProxyFrontendManager());
      const resourceReconciler = await createResourceReconciler();
      const reconciler = new StackReconciler(dockerExecutor, prisma, routingManager, resourceReconciler);

      // Compute plan
      const plan = await reconciler.plan(stackId);
      const activeActions = plan.actions.filter((a) => a.action !== 'no-op');

      // Filter by serviceNames if provided
      let plannedActions = activeActions;
      if (parsed.data.serviceNames && parsed.data.serviceNames.length > 0) {
        const filterSet = new Set(parsed.data.serviceNames);
        plannedActions = activeActions.filter((a) => filterSet.has(a.serviceName));
      }

      let startedActions: Array<{ serviceName: string; action: string }>;
      if (isForcePull && plannedActions.length === 0) {
        startedActions = plan.actions.map((a) => ({ serviceName: a.serviceName, action: 'pull' }));
      } else {
        startedActions = plannedActions.map((a) => ({ serviceName: a.serviceName, action: a.action }));
      }

      // Build resource actions for the started event so the task tracker knows about them
      const activeResourceActions = (plan.resourceActions ?? [])
        .filter((ra) => ra.action !== 'no-op')
        .map((ra) => ({ serviceName: `${ra.resourceType}:${ra.resourceName}`, action: ra.action }));
      const allStartedActions = [...startedActions, ...activeResourceActions];

      // Emit started event (now that we have the plan)
      emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_STARTED, {
        stackId,
        stackName: plan.stackName,
        totalActions: allStartedActions.length,
        actions: allStartedActions,
        forcePull: isForcePull,
      });

      // Create user event
      let userEventId: string | undefined;
      try {
        const userEvent = await userEventService.createEvent({
          eventType: 'stack_deploy',
          eventCategory: 'infrastructure',
          eventName: `Deploy ${plan.stackName} v${plan.stackVersion}`,
          userId: triggeredBy,
          triggeredBy: triggeredBy ? 'manual' : 'api',
          resourceId: stackId,
          resourceType: 'stack',
          resourceName: plan.stackName,
          status: 'running',
          progress: 0,
          description: `Deploying stack ${plan.stackName}`,
          metadata: {
            stackName: plan.stackName,
            version: plan.stackVersion,
            serviceActions: startedActions,
            forcePull: isForcePull,
          },
        });
        userEventId = userEvent.id;
      } catch (err) {
        logger.warn({ error: err, stackId }, 'Failed to create user event for stack apply');
      }

      // Count total steps: 1 (plan) + service actions + resource groups with actions
      const resourceTypes: ResourceType[] = ['tls', 'dns', 'tunnel'];
      const resourceGroupCount = resourceTypes.filter((rt) =>
        plan.resourceActions?.some((ra) => ra.resourceType === rt && ra.action !== 'no-op')
      ).length;
      const totalSteps = 1 + startedActions.length + resourceGroupCount;
      let currentStep = 1;

      // Append plan step
      const actionCounts = {
        creates: startedActions.filter((a) => a.action === 'create').length,
        recreates: startedActions.filter((a) => a.action === 'recreate').length,
        removes: startedActions.filter((a) => a.action === 'remove').length,
        updates: startedActions.filter((a) => a.action === 'update' || a.action === 'pull').length,
      };

      if (userEventId) {
        try {
          await userEventService.appendLogs(
            userEventId,
            formatPlanStep(currentStep, totalSteps, actionCounts),
          );
          await userEventService.updateEvent(userEventId, {
            progress: Math.round((currentStep / totalSteps) * 100),
          });
        } catch { /* never break apply */ }
      }

      // Unified progress counter for socket emissions (covers both services and resources)
      let emittedStepCount = 0;
      const totalEmitActions = allStartedActions.length;

      try {
        const result = await reconciler.apply(stackId, {
          ...parsed.data,
          triggeredBy,
          plan,
          onProgress: (progressResult) => {
            emittedStepCount++;
            try {
              emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_SERVICE_RESULT, {
                stackId,
                ...progressResult,
                completedCount: emittedStepCount,
                totalActions: totalEmitActions,
              } as any);
            } catch { /* never break apply */ }

            // Append to user event log (skip resource results — they're batched post-apply)
            if (userEventId) {
              try {
                const isResource = 'resourceType' in progressResult;
                if (!isResource) {
                  currentStep++;
                  const serviceResult = progressResult as ServiceApplyResult;
                  userEventService.appendLogs(
                    userEventId,
                    formatServiceStep(currentStep, totalSteps, serviceResult),
                  ).catch(() => {});
                  userEventService.updateEvent(userEventId, {
                    progress: Math.round((currentStep / totalSteps) * 100),
                  }).catch(() => {});
                }
              } catch { /* never break apply */ }
            }
          },
        });

        // Append resource group logs from the final result
        if (userEventId && result.resourceResults.length > 0) {
          try {
            const grouped = new Map<ResourceType, ResourceResult[]>();
            for (const rr of result.resourceResults) {
              const list = grouped.get(rr.resourceType) ?? [];
              list.push(rr);
              grouped.set(rr.resourceType, list);
            }
            for (const [rt, results] of grouped) {
              if (results.some((r) => r.action !== 'no-op')) {
                currentStep++;
                await userEventService.appendLogs(
                  userEventId,
                  formatResourceGroupStep(currentStep, totalSteps, rt, results.filter((r) => r.action !== 'no-op')),
                );
              }
            }
          } catch { /* never break apply */ }
        }

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

        // Monitoring post-apply
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

        // Finalize user event
        if (userEventId) {
          try {
            const failedServices = result.serviceResults.filter((r) => !r.success);
            const failedResources = result.resourceResults.filter((r) => !r.success);
            const hasFailures = failedServices.length > 0 || failedResources.length > 0;

            await userEventService.updateEvent(userEventId, {
              status: hasFailures ? 'failed' : 'completed',
              progress: 100,
              resultSummary: hasFailures
                ? `${failedServices.length} service(s) and ${failedResources.length} resource(s) failed`
                : `${result.serviceResults.length} service(s) deployed successfully`,
              ...(hasFailures
                ? {
                    errorMessage: failedServices.length > 0
                      ? `Failed services: ${failedServices.map((s) => s.serviceName).join(', ')}`
                      : `Failed resources: ${failedResources.map((r) => r.resourceName).join(', ')}`,
                    errorDetails: { failedServices, failedResources },
                  }
                : {}),
            });
          } catch { /* never break apply */ }
        }

        // Emit completed event
        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          ...result,
          postApply,
        });
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack apply failed');

        if (userEventId) {
          try {
            await userEventService.updateEvent(userEventId, {
              status: 'failed',
              errorMessage: error.message,
              errorDetails: { type: error.constructor?.name, message: error.message },
            });
          } catch { /* never break error handling */ }
        }

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

    applyingStacks.add(stackId);

    // Respond immediately — planning and update run in background
    res.json({ success: true, data: { started: true, stackId } });

    // Run planning + update in background
    const triggeredBy = (req as any).user?.id;
    const userEventService = new UserEventService(prisma);

    (async () => {
      // Initialize services
      const dockerExecutor = new DockerExecutorService();
      await dockerExecutor.initialize();
      const routingManager = new StackRoutingManager(prisma, new HAProxyFrontendManager());
      const resourceReconciler = await createResourceReconciler();
      const reconciler = new StackReconciler(dockerExecutor, prisma, routingManager, resourceReconciler);

      // Compute plan
      const plan = await reconciler.plan(stackId);
      const startedActions = plan.actions.map((a) => ({ serviceName: a.serviceName, action: 'update' }));

      // Emit started event (now that we have the plan)
      emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_STARTED, {
        stackId,
        stackName: plan.stackName,
        totalActions: startedActions.length,
        actions: startedActions,
        forcePull: true,
      });

      let userEventId: string | undefined;
      try {
        const userEvent = await userEventService.createEvent({
          eventType: 'stack_update',
          eventCategory: 'infrastructure',
          eventName: `Update ${plan.stackName}`,
          userId: triggeredBy,
          triggeredBy: triggeredBy ? 'manual' : 'api',
          resourceId: stackId,
          resourceType: 'stack',
          resourceName: plan.stackName,
          status: 'running',
          progress: 0,
          description: `Pulling latest images and updating stack ${plan.stackName}`,
          metadata: {
            stackName: plan.stackName,
            actions: startedActions,
          },
        });
        userEventId = userEvent.id;
      } catch (err) {
        logger.warn({ error: err, stackId }, 'Failed to create user event for stack update');
      }

      const totalSteps = 1 + startedActions.length;
      let currentStep = 1;

      // Append plan step
      if (userEventId) {
        try {
          await userEventService.appendLogs(
            userEventId,
            formatPlanStep(currentStep, totalSteps, {
              creates: 0,
              recreates: 0,
              removes: 0,
              updates: startedActions.length,
            }),
          );
          await userEventService.updateEvent(userEventId, {
            progress: Math.round((currentStep / totalSteps) * 100),
          });
        } catch { /* never break update */ }
      }

      try {
        const result = await reconciler.update(stackId, {
          triggeredBy,
          forceRecreate: true,
          onProgress: (serviceResult, completedCount, totalActions) => {
            try {
              emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_SERVICE_RESULT, {
                stackId,
                ...serviceResult,
                completedCount,
                totalActions,
              } as any);
            } catch { /* never break update */ }

            if (userEventId) {
              try {
                currentStep++;
                userEventService.appendLogs(
                  userEventId,
                  formatServiceStep(currentStep, totalSteps, serviceResult),
                ).catch(() => {});
                userEventService.updateEvent(userEventId, {
                  progress: Math.round((currentStep / totalSteps) * 100),
                }).catch(() => {});
              } catch { /* never break update */ }
            }
          },
        });

        // Finalize user event
        if (userEventId) {
          try {
            const failedServices = result.serviceResults.filter((r) => !r.success);
            const hasFailures = failedServices.length > 0;

            await userEventService.updateEvent(userEventId, {
              status: hasFailures ? 'failed' : 'completed',
              progress: 100,
              resultSummary: hasFailures
                ? `${failedServices.length} service(s) failed to update`
                : result.serviceResults.length === 0
                  ? 'All images are up to date'
                  : `${result.serviceResults.length} service(s) updated successfully`,
              ...(hasFailures
                ? {
                    errorMessage: `Failed services: ${failedServices.map((s) => s.serviceName).join(', ')}`,
                    errorDetails: { failedServices },
                  }
                : {}),
            });
          } catch { /* never break update */ }
        }

        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          ...result,
        });
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack update failed');

        if (userEventId) {
          try {
            await userEventService.updateEvent(userEventId, {
              status: 'failed',
              errorMessage: error.message,
              errorDetails: { type: error.constructor?.name, message: error.message },
            });
          } catch { /* never break error handling */ }
        }

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
    const userEventService = new UserEventService(prisma);

    (async () => {
      const startTime = Date.now();
      let userEventId: string | undefined;
      try {
        const userEvent = await userEventService.createEvent({
          eventType: 'stack_destroy',
          eventCategory: 'infrastructure',
          eventName: `Destroy ${stack.name}`,
          userId: triggeredBy,
          triggeredBy: triggeredBy ? 'manual' : 'api',
          resourceId: stackId,
          resourceType: 'stack',
          resourceName: stack.name,
          status: 'running',
          progress: 0,
          description: `Destroying stack ${stack.name} and all its resources`,
        });
        userEventId = userEvent.id;
      } catch (err) {
        logger.warn({ error: err, stackId }, 'Failed to create user event for stack destroy');
      }

      try {
        // Fetch full stack with environment for network/volume cleanup
        const fullStack = await prisma.stack.findUniqueOrThrow({
          where: { id: stackId },
          include: { services: true, environment: true },
        });
        const projectName = fullStack.environment ? `${fullStack.environment.name}-${fullStack.name}` : fullStack.name;
        const networks = (fullStack.networks as unknown as StackNetwork[]) ?? [];
        const volumes = (fullStack.volumes as unknown as StackVolume[]) ?? [];

        // Step 1: Destroy stack-level resources (DNS, tunnels) before container removal
        const resourceReconciler = await createResourceReconciler();
        try {
          await resourceReconciler.destroyAllResources(stackId);
          logger.info({ stackId }, 'Stack resources destroyed');
        } catch (err: any) {
          logger.warn({ error: err.message, stackId }, 'Resource destruction failed (non-fatal), continuing with container removal');
        }

        // Step 2: Get HAProxy context from stack's environment (optional)
        let haproxyContainerId = '';
        let haproxyNetworkName = '';
        let environmentId = fullStack.environmentId ?? '';
        let environmentName = fullStack.environment?.name ?? '';
        if (fullStack.environmentId) {
          try {
            const envValidation = new EnvironmentValidationService();
            const haproxyCtx = await envValidation.getHAProxyEnvironmentContext(fullStack.environmentId);
            if (haproxyCtx) {
              haproxyContainerId = haproxyCtx.haproxyContainerId;
              haproxyNetworkName = haproxyCtx.haproxyNetworkName;
            }
          } catch { /* no HAProxy available — LB steps will fail non-fatally */ }
        }

        // Step 3: Find containers by stack-id label
        const dockerService = DockerService.getInstance();
        await dockerService.initialize();
        const allContainers = await dockerService.listContainers(true);
        const stackContainers = allContainers.filter((c: any) =>
          c.labels?.['mini-infra.stack-id'] === stackId
        );
        const containerIds = stackContainers.map((c: any) => c.id);

        logger.info({ stackId, containerCount: containerIds.length }, 'Found stack containers for removal state machine');

        // Step 4: Run the removal state machine for container cleanup
        const removalContext = {
          deploymentId: stackId,
          configurationId: stackId,
          deploymentConfigId: stackId,
          applicationName: fullStack.name,
          environmentId,
          environmentName,
          haproxyContainerId,
          haproxyNetworkName,
          containersToRemove: containerIds,
          lbRemovalComplete: false,
          frontendRemoved: false,
          applicationStopped: false,
          applicationRemoved: false,
          retryCount: 0,
          triggerType: 'manual',
          triggeredBy,
          startTime,
        };

        const containersRemoved = await new Promise<number>((resolve, reject) => {
          const machine = removalDeploymentMachine.provide({});
          const actor = createActor(machine, { input: removalContext });

          actor.subscribe((state) => {
            // Emit progress via user event
            const progressMap: Record<string, number> = {
              idle: 0, removingFromLB: 10, removingFrontend: 20,
              stoppingApplication: 40, removingApplication: 60,
              cleanup: 80, completed: 100, failed: 0,
            };
            const progress = progressMap[state.value as string] ?? 0;
            if (userEventId && progress > 0) {
              userEventService.updateEvent(userEventId, { progress }).catch(() => {});
            }

            if (state.status === 'done') {
              if (state.value === 'completed') {
                resolve(containerIds.length);
              } else {
                reject(new Error(state.context.error || 'Removal state machine failed'));
              }
            }
          });

          actor.start();
          actor.send({ type: 'START_REMOVAL' });
        });

        // Step 5: Remove networks and volumes (post state machine)
        const dockerExecutor = new DockerExecutorService();
        await dockerExecutor.initialize();

        const networksRemoved: string[] = [];
        for (const net of networks) {
          const netName = `${projectName}_${net.name}`;
          try {
            if (await dockerExecutor.networkExists(netName)) {
              await dockerExecutor.removeNetwork(netName);
              networksRemoved.push(netName);
            }
          } catch (err) {
            logger.warn({ network: netName, error: err }, 'Failed to remove network, continuing');
          }
        }

        const volumesRemoved: string[] = [];
        for (const vol of volumes) {
          const volName = `${projectName}_${vol.name}`;
          try {
            if (await dockerExecutor.volumeExists(volName)) {
              await dockerExecutor.removeVolume(volName);
              volumesRemoved.push(volName);
            }
          } catch (err) {
            logger.warn({ volume: volName, error: err }, 'Failed to remove volume, continuing');
          }
        }

        // Step 6: Update stack DB records
        const duration = Date.now() - startTime;
        await prisma.stackDeployment.create({
          data: {
            stackId,
            action: 'destroy',
            success: true,
            status: 'removed',
            duration,
            triggeredBy: triggeredBy ?? null,
          },
        });

        await prisma.stack.update({
          where: { id: stackId },
          data: { status: 'removed', removedAt: new Date() },
        });

        // Build structured logs for the destroy result
        const totalSteps = 4;
        if (userEventId) {
          try {
            let logs = '';
            logs += formatDestroyResourceStep(1, totalSteps, true);
            logs += formatDestroyContainerStep(2, totalSteps, containersRemoved, containersRemoved);
            logs += formatDestroyNetworkStep(3, totalSteps, networksRemoved);
            logs += formatDestroyVolumeStep(4, totalSteps, volumesRemoved);

            await userEventService.appendLogs(userEventId, logs);
            await userEventService.updateEvent(userEventId, {
              status: 'completed',
              progress: 100,
              resultSummary: `Stack destroyed: ${containersRemoved} containers, ${networksRemoved.length} networks, ${volumesRemoved.length} volumes removed`,
            });
          } catch { /* never break destroy */ }
        }

        const result = { success: true, stackId, containersRemoved, networksRemoved, volumesRemoved, duration };
        logger.info(result, 'Stack destroyed via removal state machine');
        emitToChannel(Channel.STACKS, ServerEvent.STACK_DESTROY_COMPLETED, result);
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack destroy failed');

        if (userEventId) {
          try {
            await userEventService.updateEvent(userEventId, {
              status: 'failed',
              errorMessage: error.message,
              errorDetails: { type: error.constructor?.name, message: error.message },
            });
          } catch { /* never break error handling */ }
        }

        emitToChannel(Channel.STACKS, ServerEvent.STACK_DESTROY_COMPLETED, {
          success: false,
          stackId,
          containersRemoved: 0,
          networksRemoved: [],
          volumesRemoved: [],
          duration: Date.now() - startTime,
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
