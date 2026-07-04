/**
 * Single source of truth for deriving Docker network names.
 *
 * Before this module existed, the same handful of naming conventions were
 * re-typed as inline template literals in half a dozen files, and one of the
 * copies (the host-scoped stack-destroy path) diverged from the others —
 * silently orphaning networks on destroy. Nothing outside this module should
 * build a network name with a template literal; import the relevant
 * function instead so a convention can only drift by editing this file.
 *
 * These are pure string functions with no Docker/Prisma dependency. Project
 * name computation itself (the `<project>` half of a stack network name)
 * remains owned by `getStackProjectName()` in `../stacks/template-engine.ts`
 * — that function already correctly handles the host-vs-environment-scoped
 * stack prefix (`mini-infra-<name>` vs `<environment>-<name>`) and is used
 * for container and volume naming too, so it isn't duplicated here. Callers
 * combine it with {@link stackNetworkName} below to get a full network name.
 */

/**
 * Full Docker network name for a stack-owned network declared in
 * `StackNetwork.name` (mechanism 1 in the network overhaul design doc) —
 * including the synthesised `default` network mini-infra creates for
 * multi-service stacks that declare no `networks` at all (see
 * `synthesiseDefaultNetworkIfNeeded` in `../stacks/utils.ts`). Mirrors
 * docker-compose's `<project>_<network>` convention.
 */
export function stackNetworkName(projectName: string, networkName: string): string {
  return `${projectName}_${networkName}`;
}

/**
 * Full Docker network name for a purpose-scoped infra resource network
 * (mechanism 3/6 — an `InfraResource` row of type `docker-network`, egress
 * included). Environment-scoped resources are named `<environment>-<purpose>`;
 * host-scoped resources (no owning environment) are named `mini-infra-<purpose>`.
 */
export function resourceNetworkName(purpose: string, environmentName?: string | null): string {
  return environmentName ? `${environmentName}-${purpose}` : `mini-infra-${purpose}`;
}

/**
 * Full Docker network name for an environment's egress network (mechanism
 * 6). Always environment-scoped — egress has no host-scoped equivalent. A
 * thin, self-documenting wrapper over {@link resourceNetworkName} since the
 * two formulas are identical (`<environment>-egress`) but egress call sites
 * only ever have an environment name in hand, never a purpose string.
 */
export function egressNetworkName(environmentName: string): string {
  return resourceNetworkName('egress', environmentName);
}
