/**
 * Egress background services barrel.
 *
 * Call `startEgressBackgroundServices(prisma)` once during server startup,
 * after Docker is initialized and the DB is ready.
 *
 * Returns a shutdown function for graceful teardown.
 */

import type { PrismaClient } from '../../generated/prisma/client';
import { EgressContainerMapPusher } from './egress-container-map-pusher';
import { EgressLogIngester } from './egress-log-ingester';
import { EgressEventPruner } from './egress-event-pruner';
import { getLogger } from '../../lib/logger-factory';

const log = getLogger('stacks', 'egress-services');

export { EgressContainerMapPusher } from './egress-container-map-pusher';
export { EgressLogIngester } from './egress-log-ingester';
export { EgressEventPruner } from './egress-event-pruner';
export { EgressGatewayClient, EgressGatewayError } from './egress-gateway-client';

export type ShutdownFn = () => void;

/**
 * Wire up and start all egress background services.
 *
 * @returns A shutdown function; call it from the SIGTERM/SIGINT handler.
 */
export async function startEgressBackgroundServices(
  prisma: PrismaClient,
): Promise<ShutdownFn> {
  log.info('Starting egress background services');

  // Container-map pusher — keeps gateway in sync with running containers
  const pusher = new EgressContainerMapPusher(prisma);
  pusher.start();

  // Log ingester — tails gateway stdout and writes EgressEvent rows
  const ingester = new EgressLogIngester(prisma);
  await ingester.start();

  // Event pruner — daily retention prune
  const pruner = new EgressEventPruner(prisma);
  pruner.start();

  log.info('Egress background services started');

  return () => {
    log.info('Shutting down egress background services');
    pusher.stop();
    ingester.stop();
    pruner.stop();
    log.info('Egress background services shut down');
  };
}
