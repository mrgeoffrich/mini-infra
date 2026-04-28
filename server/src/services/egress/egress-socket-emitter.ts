/**
 * Egress Socket Emitter
 *
 * Pure helper functions that broadcast egress-firewall state changes to
 * subscribed clients on the Channel.EGRESS room.
 *
 * All helpers wrap emission in try/catch — emission failures must never
 * break the caller (route handler, pusher, ingester).
 *
 * Pattern matches container-socket-emitter.ts (standalone functions, no class).
 */

import { Channel, ServerEvent } from '@mini-infra/types';
import type {
  EgressEventBroadcast,
  EgressPolicyUpdatedEvent,
  EgressRuleMutationEvent,
  EgressGatewayHealthEvent,
  EgressEventAction,
  EgressEventProtocol,
  EgressMode,
  EgressDefaultAction,
  EgressRuleAction,
  EgressRuleSource,
} from '@mini-infra/types';
import { emitToChannel } from '../../lib/socket';
import { getLogger } from '../../lib/logger-factory';

const logger = getLogger('stacks', 'egress-socket-emitter');

// ---------------------------------------------------------------------------
// Input types — Prisma row shapes needed by each helper
// ---------------------------------------------------------------------------

/**
 * The EgressEvent row as returned by Prisma (with denormalized policy context
 * added by the ingester, which already has that data in memory).
 */
export interface EgressEventRowWithSnapshots {
  id: string;
  policyId: string;
  occurredAt: Date;
  sourceContainerId: string | null;
  sourceStackId: string | null;
  sourceServiceName: string | null;
  destination: string;
  matchedPattern: string | null;
  action: string; // 'allowed' | 'blocked' | 'observed'
  protocol: string; // 'dns' | 'sni' | 'http'
  mergedHits: number;
  /** Denormalized from the parent EgressPolicy — caller provides these */
  stackNameSnapshot: string;
  environmentNameSnapshot: string;
  environmentId: string | null;
}

/** The EgressPolicy row as returned by Prisma */
export interface EgressPolicyRow {
  id: string;
  stackId: string | null;
  environmentId: string | null;
  mode: string; // 'detect' | 'enforce'
  defaultAction: string; // 'allow' | 'block'
  version: number;
  appliedVersion: number | null;
  archivedAt: Date | null;
}

/** The EgressRule row as returned by Prisma */
export interface EgressRuleRow {
  id: string;
  policyId: string;
  pattern: string;
  action: string; // 'allow' | 'block'
  source: string; // 'user' | 'observed' | 'template'
  targets: unknown; // JSON field — string[]
  hits: number;
  lastHitAt: Date | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emit a single EgressEvent row to the egress channel.
 * Called by the log ingester after each batch insert, once per row.
 */
export function emitEgressEvent(row: EgressEventRowWithSnapshots): void {
  try {
    const payload: EgressEventBroadcast = {
      id: row.id,
      policyId: row.policyId,
      occurredAt: row.occurredAt.toISOString(),
      sourceContainerId: row.sourceContainerId,
      sourceStackId: row.sourceStackId,
      sourceServiceName: row.sourceServiceName,
      destination: row.destination,
      matchedPattern: row.matchedPattern,
      action: row.action as EgressEventAction,
      protocol: row.protocol as EgressEventProtocol,
      mergedHits: row.mergedHits,
      stackNameSnapshot: row.stackNameSnapshot,
      environmentNameSnapshot: row.environmentNameSnapshot,
      environmentId: row.environmentId,
    };

    emitToChannel(Channel.EGRESS, ServerEvent.EGRESS_EVENT, payload);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, eventId: row.id },
      'Failed to emit egress:event via socket',
    );
  }
}

/**
 * Emit an EgressPolicy updated event to the egress channel.
 * Called after policy creates/updates/archives.
 */
export function emitEgressPolicyUpdated(policy: EgressPolicyRow): void {
  try {
    const payload: EgressPolicyUpdatedEvent = {
      policyId: policy.id,
      environmentId: policy.environmentId,
      stackId: policy.stackId,
      version: policy.version,
      appliedVersion: policy.appliedVersion,
      mode: policy.mode as EgressMode,
      defaultAction: policy.defaultAction as EgressDefaultAction,
      archivedAt: policy.archivedAt ? policy.archivedAt.toISOString() : null,
    };

    emitToChannel(Channel.EGRESS, ServerEvent.EGRESS_POLICY_UPDATED, payload);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, policyId: policy.id },
      'Failed to emit egress:policy:updated via socket',
    );
  }
}

/**
 * Emit an EgressRule mutation event (created / updated / deleted).
 * Called by route handlers after rule create/patch/delete.
 */
export function emitEgressRuleMutation(args: {
  policy: EgressPolicyRow;
  ruleId: string;
  changeType: 'created' | 'updated' | 'deleted';
  rule: EgressRuleRow | null;
}): void {
  try {
    const payload: EgressRuleMutationEvent = {
      policyId: args.policy.id,
      ruleId: args.ruleId,
      changeType: args.changeType,
      rule: args.rule
        ? {
            id: args.rule.id,
            policyId: args.rule.policyId,
            pattern: args.rule.pattern,
            action: args.rule.action as EgressRuleAction,
            source: args.rule.source as EgressRuleSource,
            targets: Array.isArray(args.rule.targets) ? (args.rule.targets as string[]) : [],
            hits: args.rule.hits,
            lastHitAt: args.rule.lastHitAt ? args.rule.lastHitAt.toISOString() : null,
          }
        : null,
    };

    emitToChannel(Channel.EGRESS, ServerEvent.EGRESS_RULE_MUTATION, payload);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : err,
        policyId: args.policy.id,
        ruleId: args.ruleId,
        changeType: args.changeType,
      },
      'Failed to emit egress:rule:mutation via socket',
    );
  }
}

/**
 * Emit an EgressGatewayHealth snapshot to the egress channel.
 * Called by the rule pusher and container-map pusher after each push attempt.
 * The caller assembles the full payload — it knows the current version state.
 */
export function emitEgressGatewayHealth(snapshot: EgressGatewayHealthEvent): void {
  try {
    emitToChannel(Channel.EGRESS, ServerEvent.EGRESS_GATEWAY_HEALTH, snapshot);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : err,
        environmentId: snapshot.environmentId,
      },
      'Failed to emit egress:gateway:health via socket',
    );
  }
}
