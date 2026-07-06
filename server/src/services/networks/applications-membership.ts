import type { StackResourceInput, StackServiceDefinition } from '@mini-infra/types';
import { APPLICATIONS_NETWORK_PURPOSE, isHaproxyRoutedServiceType } from '@mini-infra/types';

/**
 * Apply-time invariant: every HAProxy-routed service (StatelessWeb /
 * AdoptedWeb) in an environment-scoped stack MUST be a member of the
 * environment's `applications` network — otherwise HAProxy cannot reach the
 * backend and `monitor-container-startup` fails the deploy.
 *
 * Historically the deploy path guaranteed this imperatively (the blue-green
 * `deploy-application-containers` force-attached the HAProxy network; the
 * AdoptedWeb attach passed it as `extraJoinNetworks`). With the declarative
 * network overhaul the membership is instead *declared* on the service
 * (`containerConfig.joinResourceNetworks: ['applications']`) plus the
 * stack-level `applications` resource input, and the shared attach/deploy
 * pipeline realises it like any other declared network.
 *
 * The authoring surfaces (the new/edit/adopt application flows) declare this
 * themselves, but relying on every surface — including the generic service
 * drawer and file-loaded templates — to remember it is fragile once the
 * imperative safety-net is removed. This module re-establishes the invariant
 * uniformly at reconcile time so the deploy path can source networks purely
 * from the declared membership.
 *
 * All functions are pure and non-mutating: they return new structures and
 * leave the stored definitions untouched (the injected membership is derived,
 * never persisted).
 */

const DOCKER_NETWORK_RESOURCE_TYPE = 'docker-network';

/** True when any resolved service in the stack routes through HAProxy. */
export function stackNeedsApplicationsNetwork(
  definitions: Iterable<Pick<StackServiceDefinition, 'serviceType'>>,
): boolean {
  for (const def of definitions) {
    if (isHaproxyRoutedServiceType(def.serviceType)) return true;
  }
  return false;
}

/**
 * Ensure `resourceInputs` declares the `applications` docker-network so
 * `resolveInputs` maps it to `<environment>-applications` at apply time.
 * Returns the same array reference when the input is already present.
 */
export function ensureApplicationsResourceInput(
  resourceInputs: StackResourceInput[],
): StackResourceInput[] {
  const already = resourceInputs.some(
    (i) => i.type === DOCKER_NETWORK_RESOURCE_TYPE && i.purpose === APPLICATIONS_NETWORK_PURPOSE,
  );
  if (already) return resourceInputs;
  return [
    ...resourceInputs,
    { type: DOCKER_NETWORK_RESOURCE_TYPE, purpose: APPLICATIONS_NETWORK_PURPOSE },
  ];
}

/**
 * Ensure a HAProxy-routed service declares the `applications` join. Non-routed
 * services and services that already declare it are returned unchanged (same
 * reference); otherwise a shallow copy with an extended `joinResourceNetworks`.
 */
export function ensureApplicationsJoinResourceNetwork(
  def: StackServiceDefinition,
): StackServiceDefinition {
  if (!isHaproxyRoutedServiceType(def.serviceType)) return def;
  const current = def.containerConfig.joinResourceNetworks ?? [];
  if (current.includes(APPLICATIONS_NETWORK_PURPOSE)) return def;
  return {
    ...def,
    containerConfig: {
      ...def.containerConfig,
      joinResourceNetworks: [...current, APPLICATIONS_NETWORK_PURPOSE],
    },
  };
}

export interface ApplicationsMembershipInputs {
  resourceInputs: StackResourceInput[];
  resolvedDefinitions: Map<string, StackServiceDefinition>;
}

/**
 * Enforce the applications-network invariant across a stack's resource inputs
 * and resolved service definitions. A no-op (returns the inputs verbatim) for
 * host-scoped stacks and stacks with no HAProxy-routed service.
 */
export function ensureApplicationsMembership(
  environmentId: string | null,
  { resourceInputs, resolvedDefinitions }: ApplicationsMembershipInputs,
): ApplicationsMembershipInputs {
  if (environmentId == null || !stackNeedsApplicationsNetwork(resolvedDefinitions.values())) {
    return { resourceInputs, resolvedDefinitions };
  }

  const nextDefinitions = new Map<string, StackServiceDefinition>();
  for (const [name, def] of resolvedDefinitions) {
    nextDefinitions.set(name, ensureApplicationsJoinResourceNetwork(def));
  }
  return {
    resourceInputs: ensureApplicationsResourceInput(resourceInputs),
    resolvedDefinitions: nextDefinitions,
  };
}
