/**
 * Egress background services barrel.
 *
 * Call `startEgressBackgroundServices(prisma)` once during server startup,
 * after Docker is initialized and the DB is ready.
 *
 * Returns a shutdown function for graceful teardown.
 *
 * ---------------------------------------------------------------------------
 * Contract for the API-routes agent
 * ---------------------------------------------------------------------------
 *
 * After any rule or policy mutation, call one of these from the route handler:
 *
 *   import { getEgressRulePusher } from '../services/egress';
 *
 *   // After mutating rules on a policy:
 *   void getEgressRulePusher().pushForPolicy(policyId);
 *
 *   // After mutating a stack's policy directly (e.g. mode/defaultAction change):
 *   void getEgressRulePusher().pushForStack(stackId);
 *
 *   // After mutating all policies in an env:
 *   void getEgressRulePusher().pushForEnvironment(envId);
 *
 * All three methods are fire-and-forget safe (they never throw; failures are
 * logged as warnings). Concurrent calls for the same env are automatically
 * coalesced to at most one queued follow-up push.
 */

import type { PrismaClient } from '../../generated/prisma/client';
import { EgressContainerMapPusher } from './egress-container-map-pusher';
import { EgressLogIngester } from './egress-log-ingester';
import { EgressEventPruner } from './egress-event-pruner';
import { EgressRulePusher } from './egress-rule-pusher';
import { getLogger } from '../../lib/logger-factory';

const log = getLogger('stacks', 'egress-services');

export { EgressContainerMapPusher } from './egress-container-map-pusher';
export { EgressLogIngester } from './egress-log-ingester';
export { EgressEventPruner } from './egress-event-pruner';
export { EgressGatewayClient, EgressGatewayError } from './egress-gateway-client';
export { EgressRulePusher } from './egress-rule-pusher';

export type ShutdownFn = () => void;

// ---------------------------------------------------------------------------
// Singleton rule pusher — lazy-init so tests can construct their own instance
// without side-effects. Populated by startEgressBackgroundServices().
// ---------------------------------------------------------------------------

let _rulePusher: EgressRulePusher | null = null;

/**
 * Return the singleton EgressRulePusher.
 *
 * Must be called after `startEgressBackgroundServices()` has been awaited.
 * Calling before startup throws so route handlers catch misconfiguration early.
 */
export function getEgressRulePusher(): EgressRulePusher {
  if (!_rulePusher) {
    throw new Error(
      'getEgressRulePusher() called before startEgressBackgroundServices() — ensure egress services are started at boot',
    );
  }
  return _rulePusher;
}

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

  // Rule pusher — keeps gateway rules in sync with DB EgressPolicy/EgressRule
  const rulePusher = new EgressRulePusher(prisma);
  await rulePusher.start();
  _rulePusher = rulePusher;

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
    rulePusher.stop();
    ingester.stop();
    pruner.stop();
    log.info('Egress background services shut down');
  };
}
