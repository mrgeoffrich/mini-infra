import type { PrismaClient } from '../../generated/prisma/client';
import type * as runtime from '@prisma/client/runtime/client';
import { getLogger } from '../../lib/logger-factory';
import type { EgressArchivedReason, StackContainerConfig } from '@mini-infra/types';
import { emitEgressPolicyUpdated, emitEgressRuleMutation } from './egress-socket-emitter';

const log = getLogger('stacks', 'egress-policy-lifecycle');

/**
 * Built-in templates whose stacks are firewall infrastructure themselves
 * (haproxy is the in-environment router; egress-gateway IS the firewall).
 * Egress policies for these stacks are nonsensical — circular for
 * egress-gateway and breaks east-west routing for haproxy — so we never
 * create them and archive any that already exist.
 */
const EGRESS_EXCLUDED_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  'haproxy',
  'egress-gateway',
]);

/**
 * Manages the lifecycle of EgressPolicy rows in lockstep with Stack and
 * Environment lifecycle events.
 *
 * All methods wrap in try/catch and log errors rather than throwing — a
 * failure to manage egress policy state must never break stack/env operations.
 */
export class EgressPolicyLifecycleService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Called after a new Stack row is created.
   *
   * If the stack is env-scoped, upserts a default EgressPolicy:
   *   mode=detect, defaultAction=allow, empty rules, snapshots seeded from
   *   the stack + env.
   *
   * If a non-archived policy already exists for this stack (e.g. retry), only
   * the snapshot fields and updatedBy are refreshed — mode/defaultAction/rules
   * are left untouched (they may have been edited by the operator).
   *
   * No-op for host-scoped stacks (environmentId === null).
   */
  async ensureDefaultPolicy(stackId: string, userId: string | null): Promise<void> {
    try {
      const stack = await this.prisma.stack.findUnique({
        where: { id: stackId },
        include: { environment: true, template: { select: { name: true } } },
      });

      if (!stack) {
        log.warn({ stackId }, 'ensureDefaultPolicy: stack not found, skipping');
        return;
      }

      // Host-scoped stacks are not firewalled in v1
      if (!stack.environmentId || !stack.environment) {
        log.debug({ stackId }, 'ensureDefaultPolicy: host-scoped stack, skipping');
        return;
      }

      // Skip firewall infrastructure stacks (haproxy, egress-gateway). Archive
      // any policy that may already exist from a previous deployment so it
      // disappears from the egress UI.
      if (stack.template?.name && EGRESS_EXCLUDED_TEMPLATE_NAMES.has(stack.template.name)) {
        await this.archiveExcludedPolicyForStack(stackId, userId);
        log.debug(
          { stackId, templateName: stack.template.name },
          'ensureDefaultPolicy: skipping excluded infrastructure stack',
        );
        return;
      }

      const stackNameSnapshot = stack.name;
      const environmentNameSnapshot = stack.environment.name;

      // Check for an existing non-archived policy for this stack
      const existing = await this.prisma.egressPolicy.findFirst({
        where: { stackId, archivedAt: null },
      });

      if (existing) {
        // Policy exists — only refresh snapshots and updatedBy
        const updated = await this.prisma.egressPolicy.update({
          where: { id: existing.id },
          data: {
            stackNameSnapshot,
            environmentNameSnapshot,
            updatedBy: userId,
          },
        });
        log.debug(
          { stackId, policyId: existing.id },
          'ensureDefaultPolicy: refreshed snapshots on existing policy',
        );
        emitEgressPolicyUpdated(updated);
        return;
      }

      // No non-archived policy — create a fresh default policy
      const policy = await this.prisma.egressPolicy.create({
        data: {
          stackId,
          stackNameSnapshot,
          environmentId: stack.environmentId,
          environmentNameSnapshot,
          mode: 'detect',
          defaultAction: 'allow',
          createdBy: userId,
          updatedBy: userId,
        },
      });

      log.info(
        { stackId, policyId: policy.id, environmentId: stack.environmentId },
        'ensureDefaultPolicy: created default egress policy',
      );
      emitEgressPolicyUpdated(policy);
    } catch (err) {
      log.error(
        { err, stackId },
        'ensureDefaultPolicy: failed to ensure default egress policy — continuing without it',
      );
    }
  }

  /**
   * Archive any non-archived policy for an infrastructure stack that should
   * never be firewalled (haproxy, egress-gateway). Caller is responsible for
   * deciding the stack qualifies — this just performs the write.
   */
  private async archiveExcludedPolicyForStack(
    stackId: string,
    userId: string | null,
  ): Promise<void> {
    const archivedAt = new Date();
    const result = await this.prisma.egressPolicy.updateMany({
      where: { stackId, archivedAt: null },
      data: {
        archivedAt,
        archivedReason: 'system-infrastructure-stack' satisfies EgressArchivedReason,
        updatedBy: userId,
      },
    });

    if (result.count > 0) {
      const policies = await this.prisma.egressPolicy.findMany({
        where: {
          stackId,
          archivedReason: 'system-infrastructure-stack' satisfies EgressArchivedReason,
          archivedAt,
        },
      });
      for (const policy of policies) {
        emitEgressPolicyUpdated(policy);
      }
      log.info(
        { stackId, archivedCount: result.count },
        'archiveExcludedPolicyForStack: archived policy on excluded infrastructure stack',
      );
    }
  }

  /**
   * One-shot startup cleanup. Finds policies whose stack is one of the
   * firewall-excluded built-in templates (haproxy, egress-gateway) and
   * archives them so older deployments stop showing them on the egress page.
   * Idempotent.
   */
  async archiveExcludedStackPolicies(): Promise<void> {
    try {
      const policies = await this.prisma.egressPolicy.findMany({
        where: {
          archivedAt: null,
          stack: {
            template: { name: { in: Array.from(EGRESS_EXCLUDED_TEMPLATE_NAMES) } },
          },
        },
        select: { stackId: true },
      });

      const stackIds = Array.from(
        new Set(policies.map((p) => p.stackId).filter((id): id is string => id !== null)),
      );

      for (const stackId of stackIds) {
        await this.archiveExcludedPolicyForStack(stackId, null);
      }
    } catch (err) {
      log.error(
        { err },
        'archiveExcludedStackPolicies: failed to clean up excluded-stack policies — continuing',
      );
    }
  }

  /**
   * Set archivedAt on the non-archived policy for this stack.
   * Idempotent — no-op if already archived or no policy exists.
   */
  async archiveForStack(stackId: string, userId: string | null): Promise<void> {
    try {
      const archivedAt = new Date();
      const result = await this.prisma.egressPolicy.updateMany({
        where: { stackId, archivedAt: null },
        data: {
          archivedAt,
          archivedReason: 'stack-deleted' satisfies EgressArchivedReason,
          updatedBy: userId,
        },
      });

      if (result.count > 0) {
        log.info(
          { stackId, updatedCount: result.count },
          'archiveForStack: archived egress policies for stack',
        );

        // Emit one event per affected policy — fetch them after the update
        // (archivedAt is now set, so query with archivedReason to narrow)
        const policies = await this.prisma.egressPolicy.findMany({
          where: { stackId, archivedReason: 'stack-deleted' satisfies EgressArchivedReason, archivedAt },
        });
        for (const policy of policies) {
          emitEgressPolicyUpdated(policy);
        }
      }
    } catch (err) {
      log.error(
        { err, stackId },
        'archiveForStack: failed to archive egress policy — continuing',
      );
    }
  }

  /**
   * Set archivedAt on every non-archived policy in the environment.
   * Idempotent — skips already-archived rows.
   *
   * This is the safety-net call during env delete: it catches policies whose
   * stack rows may already have been NULLed by the stack-delete hook or by
   * the Prisma onDelete: SetNull cascade.
   */
  async archiveForEnvironment(environmentId: string, userId: string | null): Promise<void> {
    try {
      const archivedAt = new Date();
      const result = await this.prisma.egressPolicy.updateMany({
        where: { environmentId, archivedAt: null },
        data: {
          archivedAt,
          archivedReason: 'environment-deleted' satisfies EgressArchivedReason,
          updatedBy: userId,
        },
      });

      if (result.count > 0) {
        log.info(
          { environmentId, updatedCount: result.count },
          'archiveForEnvironment: archived egress policies for environment',
        );

        // Emit one event per affected policy
        const policies = await this.prisma.egressPolicy.findMany({
          where: { environmentId, archivedReason: 'environment-deleted' satisfies EgressArchivedReason, archivedAt },
        });
        for (const policy of policies) {
          emitEgressPolicyUpdated(policy);
        }
      }
    } catch (err) {
      log.error(
        { err, environmentId },
        'archiveForEnvironment: failed to archive egress policies — continuing',
      );
    }
  }

  /**
   * Refresh stackNameSnapshot for the stack's non-archived policy.
   * No-op if no policy exists for the stack.
   */
  async refreshStackNameSnapshot(stackId: string): Promise<void> {
    try {
      const stack = await this.prisma.stack.findUnique({
        where: { id: stackId },
        select: { name: true },
      });

      if (!stack) {
        log.debug({ stackId }, 'refreshStackNameSnapshot: stack not found, skipping');
        return;
      }

      const result = await this.prisma.egressPolicy.updateMany({
        where: { stackId, archivedAt: null },
        data: { stackNameSnapshot: stack.name },
      });

      if (result.count > 0) {
        log.debug(
          { stackId, stackName: stack.name },
          'refreshStackNameSnapshot: updated stack name snapshot',
        );

        // Emit one event per affected policy
        const policies = await this.prisma.egressPolicy.findMany({
          where: { stackId, archivedAt: null, stackNameSnapshot: stack.name },
        });
        for (const policy of policies) {
          emitEgressPolicyUpdated(policy);
        }
      }
    } catch (err) {
      log.error(
        { err, stackId },
        'refreshStackNameSnapshot: failed to refresh stack name snapshot — continuing',
      );
    }
  }

  /**
   * Reconcile the EgressRule rows of source='template' for a stack so that
   * they exactly match the union of `requiredEgress` declarations across the
   * stack's services. Creates new rules, updates `targets` if a service set
   * changes, and deletes rules whose pattern is no longer declared.
   *
   * Idempotent. Called after stack create and after stack updates that may
   * have changed service definitions.
   *
   * Triggers a gateway push afterwards.
   */
  async reconcileTemplateRules(stackId: string, userId: string | null): Promise<void> {
    try {
      // 1. Load the stack's services and their requiredEgress declarations.
      const stack = await this.prisma.stack.findUnique({
        where: { id: stackId },
        select: {
          environmentId: true,
          services: {
            select: {
              serviceName: true,
              containerConfig: true,
            },
          },
        },
      });

      if (!stack) {
        log.debug({ stackId }, 'reconcileTemplateRules: stack not found, skipping');
        return;
      }

      // Host-scoped stacks have no egress policy — skip.
      if (!stack.environmentId) {
        log.debug({ stackId }, 'reconcileTemplateRules: host-scoped stack, skipping');
        return;
      }

      // 2. Build Map<pattern, Set<serviceName>> from requiredEgress declarations.
      const desiredPatterns = new Map<string, Set<string>>();
      for (const svc of stack.services) {
        const config = svc.containerConfig as unknown as StackContainerConfig;
        if (!config?.requiredEgress) continue;
        for (const pattern of config.requiredEgress) {
          const targets = desiredPatterns.get(pattern) ?? new Set<string>();
          targets.add(svc.serviceName);
          desiredPatterns.set(pattern, targets);
        }
      }

      // 3. Load the stack's active EgressPolicy.
      const policy = await this.prisma.egressPolicy.findFirst({
        where: { stackId, archivedAt: null },
      });

      if (!policy) {
        log.debug({ stackId }, 'reconcileTemplateRules: no active policy found, skipping');
        return;
      }

      // 4. Load existing template-sourced rules for this policy.
      const existingRules = await this.prisma.egressRule.findMany({
        where: { policyId: policy.id, source: 'template' },
      });

      const existingByPattern = new Map(existingRules.map((r) => [r.pattern, r]));

      let policyVersionBump = 0;

      // 5. Diff: create / update / delete.
      for (const [pattern, serviceSet] of desiredPatterns) {
        const targets = Array.from(serviceSet).sort();
        const existing = existingByPattern.get(pattern);

        if (!existing) {
          // Create
          const rule = await this.prisma.egressRule.create({
            data: {
              policyId: policy.id,
              pattern,
              action: 'allow',
              source: 'template',
              targets: targets as unknown as runtime.InputJsonValue,
              createdBy: userId,
              updatedBy: userId,
            },
          });
          policyVersionBump += 1;
          log.debug({ stackId, policyId: policy.id, pattern }, 'reconcileTemplateRules: created rule');
          emitEgressRuleMutation({
            policy: { ...policy, version: policy.version + policyVersionBump },
            ruleId: rule.id,
            changeType: 'created',
            rule,
          });
        } else {
          // Update only if targets differ
          const existingTargets = (Array.isArray(existing.targets)
            ? (existing.targets as string[])
            : []
          ).sort();
          if (JSON.stringify(existingTargets) !== JSON.stringify(targets)) {
            const updated = await this.prisma.egressRule.update({
              where: { id: existing.id },
              data: {
                targets: targets as unknown as runtime.InputJsonValue,
                updatedBy: userId,
              },
            });
            policyVersionBump += 1;
            log.debug({ stackId, policyId: policy.id, pattern }, 'reconcileTemplateRules: updated rule targets');
            emitEgressRuleMutation({
              policy: { ...policy, version: policy.version + policyVersionBump },
              ruleId: updated.id,
              changeType: 'updated',
              rule: updated,
            });
          }
        }
      }

      // Delete template rules whose pattern is no longer declared.
      for (const [pattern, existing] of existingByPattern) {
        if (!desiredPatterns.has(pattern)) {
          await this.prisma.egressRule.delete({ where: { id: existing.id } });
          policyVersionBump += 1;
          log.debug({ stackId, policyId: policy.id, pattern }, 'reconcileTemplateRules: deleted rule');
          emitEgressRuleMutation({
            policy: { ...policy, version: policy.version + policyVersionBump },
            ruleId: existing.id,
            changeType: 'deleted',
            rule: null,
          });
        }
      }

      // 6. Bump policy version if anything changed.
      if (policyVersionBump > 0) {
        const updated = await this.prisma.egressPolicy.update({
          where: { id: policy.id },
          data: {
            version: { increment: policyVersionBump },
            updatedBy: userId,
          },
        });
        log.info(
          { stackId, policyId: policy.id, policyVersionBump },
          'reconcileTemplateRules: policy version bumped',
        );
        emitEgressPolicyUpdated(updated);
      }

      // 7. Fire-and-forget gateway push.
      void import('./index').then(async ({ getEgressRulePusher }) => {
        try {
          await getEgressRulePusher().pushForStack(stackId);
        } catch (err) {
          log.warn({ err, stackId }, 'reconcileTemplateRules: gateway push failed (non-fatal)');
        }
      }).catch((err) => {
        log.warn({ err, stackId }, 'reconcileTemplateRules: egress module import failed (non-fatal)');
      });
    } catch (err) {
      log.error(
        { err, stackId },
        'reconcileTemplateRules: failed — continuing without template rule reconciliation',
      );
    }
  }

  /**
   * Bulk-refresh environmentNameSnapshot for all non-archived policies in the env.
   * No-op if no policies exist for the environment.
   */
  async refreshEnvironmentNameSnapshot(environmentId: string): Promise<void> {
    try {
      const environment = await this.prisma.environment.findUnique({
        where: { id: environmentId },
        select: { name: true },
      });

      if (!environment) {
        log.debug(
          { environmentId },
          'refreshEnvironmentNameSnapshot: environment not found, skipping',
        );
        return;
      }

      const result = await this.prisma.egressPolicy.updateMany({
        where: { environmentId, archivedAt: null },
        data: { environmentNameSnapshot: environment.name },
      });

      if (result.count > 0) {
        log.debug(
          { environmentId, environmentName: environment.name },
          'refreshEnvironmentNameSnapshot: updated environment name snapshot',
        );

        // Emit one event per affected policy
        const policies = await this.prisma.egressPolicy.findMany({
          where: { environmentId, archivedAt: null, environmentNameSnapshot: environment.name },
        });
        for (const policy of policies) {
          emitEgressPolicyUpdated(policy);
        }
      }
    } catch (err) {
      log.error(
        { err, environmentId },
        'refreshEnvironmentNameSnapshot: failed to refresh environment name snapshot — continuing',
      );
    }
  }
}
