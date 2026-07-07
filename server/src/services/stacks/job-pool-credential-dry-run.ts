import type { PrismaClient } from '../../generated/prisma/client';
import type {
  StackContainerConfig,
  StackParameterDefinition,
  StackParameterValue,
} from '@mini-infra/types';
import { VaultCredentialInjector } from '../vault/vault-credential-injector';
import { vaultServicesReady } from '../vault/vault-services';
import { NatsCredentialInjector } from '../nats/nats-credential-injector';
import { resolveEffectiveVaultBinding } from './vault-binding-resolver';
import { getLogger } from '../../lib/logger-factory';
import { InternalError } from '../../lib/errors';
import {
  buildStackTemplateContext,
  mergeParameterValues,
  resolveServiceConfigs,
} from './utils';

const log = getLogger('stacks', 'job-pool-credential-dry-run');

/**
 * Apply-time credential dry-run for every JobPool service on a stack.
 *
 * Re-uses the same `VaultCredentialInjector` and `NatsCredentialInjector`
 * that `pool-spawner.ts` invokes at spawn time, so a misconfigured
 * `dynamicEnv` binding fails the *apply* fast rather than surfacing later
 * as a per-run spawn error when an operator tries to trigger the pool.
 *
 * Static-service `dynamicEnv` is already resolved by
 * `StackReconciler.resolveVaultEnv` during apply; JobPool services are
 * deliberately skipped there (per-instance/per-run resolution at spawn
 * time), so without this helper a broken binding only shows up when a
 * trigger fires. The plan calls this out as one of the Phase 3 known
 * constraints — surfacing latent misconfigurations from existing stacks
 * on first re-apply post-upgrade.
 *
 * Throws on the first JobPool service that fails resolution with a
 * descriptive error message. The apply route catches and surfaces it as
 * the apply failure reason.
 */
export async function dryRunJobPoolCredentials(
  prisma: PrismaClient,
  stackId: string,
): Promise<void> {
  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    include: { services: true, environment: true },
  });
  if (!stack) return;

  const jobPoolServices = stack.services.filter((s) => s.serviceType === 'JobPool');
  if (jobPoolServices.length === 0) return;

  const params = mergeParameterValues(
    (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
    (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {},
  );
  const templateContext = buildStackTemplateContext(stack, params);
  // Pass a stable, identifiable instanceId so any template substitutions
  // resolve. The dry-run never actually spawns — `instance.instanceId`
  // exists purely for template-string interpolation parity with the
  // live spawn path.
  const { resolvedDefinitions } = await resolveServiceConfigs(
    stack.services,
    templateContext,
    { instance: { instanceId: 'apply-dry-run' } },
  );

  const vaultReady = vaultServicesReady();
  const vaultInjector = vaultReady ? new VaultCredentialInjector(prisma) : null;
  const natsInjector = new NatsCredentialInjector(prisma);

  for (const svc of jobPoolServices) {
    const resolved = resolvedDefinitions.get(svc.serviceName);
    if (!resolved) continue;

    const containerConfig = resolved.containerConfig as StackContainerConfig | undefined;
    const dynamicEnv = containerConfig?.dynamicEnv;
    if (!dynamicEnv) continue;

    const hasVaultEntries = Object.values(dynamicEnv).some(
      (src) =>
        src.kind === 'vault-addr' ||
        src.kind === 'vault-role-id' ||
        src.kind === 'vault-wrapped-secret-id' ||
        src.kind === 'vault-kv',
    );
    const hasNatsEntries = Object.values(dynamicEnv).some(
      (src) =>
        src.kind === 'nats-url' ||
        src.kind === 'nats-creds' ||
        src.kind === 'nats-creds-file' ||
        src.kind === 'nats-signer-seed' ||
        src.kind === 'nats-account-public',
    );

    if (hasVaultEntries) {
      if (!vaultInjector) {
        throw new InternalError(
          `JobPool service "${svc.serviceName}" declares Vault dynamicEnv but Vault is not ready — refusing to apply (would silently spawn without credentials)`,
        );
      }
      const binding = resolveEffectiveVaultBinding(stack, svc);
      const hasAppRoleEntries = Object.values(dynamicEnv).some(
        (src) => src.kind === 'vault-role-id' || src.kind === 'vault-wrapped-secret-id',
      );
      if (hasAppRoleEntries && !binding.appRoleId) {
        throw new InternalError(
          `JobPool service "${svc.serviceName}" declares vault-role-id or vault-wrapped-secret-id but no AppRole is bound on the service or stack`,
        );
      }
      try {
        await vaultInjector.resolve(
          {
            appRoleId: binding.appRoleId,
            failClosed: false,
            prevBoundAppRoleId: binding.prevBoundAppRoleId,
            poolTokens: {},
          },
          containerConfig!,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          { stackId, serviceName: svc.serviceName, err: msg },
          'JobPool Vault credential dry-run failed',
        );
        const wrapped = new InternalError(
          `Vault credential dry-run failed for JobPool service "${svc.serviceName}": ${msg}`,
        );
        wrapped.cause = err;
        throw wrapped;
      }
    }

    if (hasNatsEntries) {
      try {
        await natsInjector.resolve(
          svc.natsCredentialId ?? null,
          containerConfig!,
          { stackId },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          { stackId, serviceName: svc.serviceName, err: msg },
          'JobPool NATS credential dry-run failed',
        );
        const wrapped = new InternalError(
          `NATS credential dry-run failed for JobPool service "${svc.serviceName}": ${msg}`,
        );
        wrapped.cause = err;
        throw wrapped;
      }
    }
  }

  log.info(
    { stackId, jobPoolCount: jobPoolServices.length },
    'JobPool credential dry-run passed',
  );
}
