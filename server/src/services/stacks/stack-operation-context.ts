import prisma from '../../lib/prisma';
import { DockerExecutorService } from '../docker-executor';
import { HAProxyFrontendManager } from '../haproxy';
import { StackReconciler } from './stack-reconciler';
import { StackResourceReconciler } from './stack-resource-reconciler';
import { StackRoutingManager } from './stack-routing-manager';
import { createResourceReconciler } from './resource-reconciler-factory';

export interface StackOperationServices {
  dockerExecutor: DockerExecutorService;
  routingManager: StackRoutingManager;
  resourceReconciler: StackResourceReconciler;
  reconciler: StackReconciler;
}

/**
 * Build the set of services needed by a long-running stack operation
 * (apply / update). These are expensive to initialize: DockerExecutor
 * connects to the Docker daemon, resource reconciler wires up Cloudflare +
 * Azure Storage + ACME. Build once per operation and pass through, rather
 * than re-building per step.
 */
export async function buildStackOperationServices(): Promise<StackOperationServices> {
  const dockerExecutor = new DockerExecutorService();
  await dockerExecutor.initialize();
  const routingManager = new StackRoutingManager(prisma, new HAProxyFrontendManager());
  const resourceReconciler = await createResourceReconciler();
  const reconciler = new StackReconciler(dockerExecutor, prisma, routingManager, resourceReconciler);
  return { dockerExecutor, routingManager, resourceReconciler, reconciler };
}
