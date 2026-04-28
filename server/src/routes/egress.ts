import { Router } from 'express';
import { z } from 'zod';
import type * as runtime from '@prisma/client/runtime/client';
import prisma from '../lib/prisma';
import { getLogger } from '../lib/logger-factory';
import { asyncHandler } from '../lib/async-handler';
import { requirePermission } from '../middleware/auth';
import { getUserId } from '../lib/get-user-id';
import type { EgressPolicySummary, EgressRuleSummary } from '@mini-infra/types';
import {
  emitEgressPolicyUpdated,
  emitEgressRuleMutation,
} from '../services/egress/egress-socket-emitter';

const logger = getLogger('stacks', 'egress-routes');

const router = Router();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const FQDN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const WILDCARD_RE = /^\*\.([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

const patternSchema = z.string().refine(
  (v) => FQDN_RE.test(v) || WILDCARD_RE.test(v),
  {
    message:
      'pattern must be a valid FQDN (e.g. api.example.com) or wildcard (e.g. *.example.com)',
  },
);

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const patchPolicySchema = z.object({
  mode: z.enum(['detect', 'enforce']).optional(),
  defaultAction: z.enum(['allow', 'block']).optional(),
});

const createRuleSchema = z.object({
  pattern: patternSchema,
  action: z.enum(['allow', 'block']),
  targets: z.array(z.string()).default([]),
});

const patchRuleSchema = z.object({
  pattern: patternSchema.optional(),
  action: z.enum(['allow', 'block']).optional(),
  targets: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Gateway push helper (fire-and-forget)
// ---------------------------------------------------------------------------

function fireAndForgetPush(policyId: string): void {
  // getEgressRulePusher() is populated by startEgressBackgroundServices() at
  // server startup. We import lazily so tests can mock the module without
  // triggering startup side-effects. Failures are swallowed — the DB
  // mutation has already succeeded and the push is best-effort.
  void import('../services/egress/index')
    .then(async ({ getEgressRulePusher }) => {
      try {
        await getEgressRulePusher().pushForPolicy(policyId);
      } catch (err) {
        logger.warn({ err, policyId }, 'egress push after mutation failed (non-fatal)');
      }
    })
    .catch((err) => {
      logger.warn({ err, policyId }, 'egress push module import failed (non-fatal)');
    });
}

// ---------------------------------------------------------------------------
// Serialisers
// ---------------------------------------------------------------------------

type PolicyRow = {
  id: string;
  stackId: string | null;
  stackNameSnapshot: string;
  environmentId: string | null;
  environmentNameSnapshot: string;
  mode: string;
  defaultAction: string;
  version: number;
  appliedVersion: number | null;
  archivedAt: Date | null;
  archivedReason: string | null;
};

type RuleRow = {
  id: string;
  policyId: string;
  pattern: string;
  action: string;
  source: string;
  targets: runtime.JsonValue;
  hits: number;
  lastHitAt: Date | null;
};

function serializePolicy(p: PolicyRow): EgressPolicySummary {
  return {
    id: p.id,
    stackId: p.stackId,
    stackNameSnapshot: p.stackNameSnapshot,
    environmentId: p.environmentId,
    environmentNameSnapshot: p.environmentNameSnapshot,
    mode: p.mode as 'detect' | 'enforce',
    defaultAction: p.defaultAction as 'allow' | 'block',
    version: p.version,
    appliedVersion: p.appliedVersion,
    archivedAt: p.archivedAt ? p.archivedAt.toISOString() : null,
    archivedReason: p.archivedReason as EgressPolicySummary['archivedReason'],
  };
}

function serializeRule(r: RuleRow): EgressRuleSummary {
  return {
    id: r.id,
    policyId: r.policyId,
    pattern: r.pattern,
    action: r.action as 'allow' | 'block',
    source: r.source as 'user' | 'observed' | 'template',
    targets: Array.isArray(r.targets) ? (r.targets as string[]) : [],
    hits: r.hits,
    lastHitAt: r.lastHitAt ? r.lastHitAt.toISOString() : null,
  };
}

// Event row shape with the parent policy's snapshot fields included
// so we can return EgressEventBroadcast-shaped objects to the frontend.
type EventRowWithPolicy = {
  id: string;
  policyId: string;
  occurredAt: Date;
  sourceContainerId: string | null;
  sourceStackId: string | null;
  sourceServiceName: string | null;
  destination: string;
  matchedPattern: string | null;
  action: string;
  protocol: string;
  mergedHits: number;
  policy: {
    stackNameSnapshot: string;
    environmentNameSnapshot: string;
    environmentId: string | null;
  };
};

function serializeEvent(e: EventRowWithPolicy) {
  return {
    id: e.id,
    policyId: e.policyId,
    occurredAt: e.occurredAt.toISOString(),
    sourceContainerId: e.sourceContainerId,
    sourceStackId: e.sourceStackId,
    sourceServiceName: e.sourceServiceName,
    destination: e.destination,
    matchedPattern: e.matchedPattern,
    action: e.action as 'allowed' | 'blocked' | 'observed',
    protocol: e.protocol as 'dns' | 'sni' | 'http',
    mergedHits: e.mergedHits,
    stackNameSnapshot: e.policy.stackNameSnapshot,
    environmentNameSnapshot: e.policy.environmentNameSnapshot,
    environmentId: e.policy.environmentId,
  };
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

function buildPaginationMeta(total: number, page: number, limit: number) {
  const totalPages = Math.ceil(total / limit);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

// ===========================================================================
// POLICIES
// ===========================================================================

// GET /api/egress/policies
// List policies. Query: environmentId, stackId, archived (bool), page, limit.
// Response: { policies, total, page, limit, totalPages, hasNextPage, hasPreviousPage }
router.get(
  '/policies',
  requirePermission('egress:read'),
  asyncHandler(async (req, res) => {
    const { environmentId, stackId, archived } = req.query;

    const pagination = paginationSchema.safeParse({
      page: req.query.page,
      limit: req.query.limit,
    });
    if (!pagination.success) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid pagination parameters',
        details: pagination.error.issues,
      });
    }
    const { page, limit } = pagination.data;

    const showArchived = archived === 'true';

    const where = {
      ...(environmentId ? { environmentId: String(environmentId) } : {}),
      ...(stackId ? { stackId: String(stackId) } : {}),
      ...(showArchived ? {} : { archivedAt: null }),
    };

    const [policies, total] = await Promise.all([
      prisma.egressPolicy.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.egressPolicy.count({ where }),
    ]);

    return res.json({
      ...buildPaginationMeta(total, page, limit),
      policies: policies.map(serializePolicy),
    });
  }),
);

// GET /api/egress/policies/:policyId — single policy with rules embedded
// Response: { ...EgressPolicySummary, rules: EgressRuleSummary[] }
router.get(
  '/policies/:policyId',
  requirePermission('egress:read'),
  asyncHandler(async (req, res) => {
    const policy = await prisma.egressPolicy.findUnique({
      where: { id: String(req.params.policyId) },
      include: { rules: { orderBy: { createdAt: 'asc' } } },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Not Found', message: 'Egress policy not found' });
    }

    return res.json({
      ...serializePolicy(policy),
      rules: policy.rules.map(serializeRule),
    });
  }),
);

// PATCH /api/egress/policies/:policyId — update mode and/or defaultAction
// Body: { mode?: 'detect'|'enforce', defaultAction?: 'allow'|'block' }
// Response: EgressPolicySummary
router.patch(
  '/policies/:policyId',
  requirePermission('egress:write'),
  asyncHandler(async (req, res) => {
    const parsed = patchPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Validation failed',
        details: parsed.error.issues,
      });
    }

    const policy = await prisma.egressPolicy.findUnique({
      where: { id: String(req.params.policyId) },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Not Found', message: 'Egress policy not found' });
    }

    if (policy.archivedAt !== null) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Cannot modify an archived egress policy',
      });
    }

    const userId = getUserId(req) ?? null;
    const updated = await prisma.egressPolicy.update({
      where: { id: policy.id },
      data: {
        ...(parsed.data.mode !== undefined ? { mode: parsed.data.mode } : {}),
        ...(parsed.data.defaultAction !== undefined ? { defaultAction: parsed.data.defaultAction } : {}),
        version: policy.version + 1,
        updatedBy: userId,
      },
    });

    logger.info({ policyId: policy.id, userId }, 'egress policy updated');
    emitEgressPolicyUpdated(updated);
    fireAndForgetPush(policy.id);

    return res.json(serializePolicy(updated));
  }),
);

// ===========================================================================
// RULES (nested under policies)
// ===========================================================================

// GET /api/egress/policies/:policyId/rules
// Response: { rules: EgressRuleSummary[] }
router.get(
  '/policies/:policyId/rules',
  requirePermission('egress:read'),
  asyncHandler(async (req, res) => {
    const policy = await prisma.egressPolicy.findUnique({
      where: { id: String(req.params.policyId) },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Not Found', message: 'Egress policy not found' });
    }

    const rules = await prisma.egressRule.findMany({
      where: { policyId: policy.id },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({ rules: rules.map(serializeRule) });
  }),
);

// POST /api/egress/policies/:policyId/rules — create a rule
// Body: { pattern: string, action: 'allow'|'block', targets?: string[] }
// Response (201): EgressRuleSummary
router.post(
  '/policies/:policyId/rules',
  requirePermission('egress:write'),
  asyncHandler(async (req, res) => {
    const parsed = createRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Validation failed',
        details: parsed.error.issues,
      });
    }

    const policy = await prisma.egressPolicy.findUnique({
      where: { id: String(req.params.policyId) },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Not Found', message: 'Egress policy not found' });
    }

    if (policy.archivedAt !== null) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Cannot add rules to an archived egress policy',
      });
    }

    const userId = getUserId(req) ?? null;
    const { pattern, action, targets } = parsed.data;

    const [rule, updatedPolicyAfterCreate] = await prisma.$transaction([
      prisma.egressRule.create({
        data: {
          policyId: policy.id,
          pattern,
          action,
          source: 'user',
          targets: targets as unknown as runtime.InputJsonValue,
          createdBy: userId,
          updatedBy: userId,
        },
      }),
      prisma.egressPolicy.update({
        where: { id: policy.id },
        data: {
          version: policy.version + 1,
          updatedBy: userId,
        },
      }),
    ]);

    logger.info({ policyId: policy.id, ruleId: rule.id, userId }, 'egress rule created');
    emitEgressRuleMutation({
      policy: updatedPolicyAfterCreate,
      ruleId: rule.id,
      changeType: 'created',
      rule,
    });
    fireAndForgetPush(policy.id);

    return res.status(201).json(serializeRule(rule));
  }),
);

// ===========================================================================
// RULES (top-level — by ruleId)
// ===========================================================================

// PATCH /api/egress/rules/:ruleId
// Body: { pattern?: string, action?: 'allow'|'block', targets?: string[] }
// Response: EgressRuleSummary
router.patch(
  '/rules/:ruleId',
  requirePermission('egress:write'),
  asyncHandler(async (req, res) => {
    const parsed = patchRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Validation failed',
        details: parsed.error.issues,
      });
    }

    const ruleWithPolicy = await prisma.egressRule.findUnique({
      where: { id: String(req.params.ruleId) },
      include: { policy: true },
    });

    if (!ruleWithPolicy) {
      return res.status(404).json({ error: 'Not Found', message: 'Egress rule not found' });
    }

    const { policy } = ruleWithPolicy;

    if (policy.archivedAt !== null) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Cannot modify a rule belonging to an archived egress policy',
      });
    }

    const userId = getUserId(req) ?? null;
    const { pattern, action, targets } = parsed.data;

    const [updated, updatedPolicyAfterPatch] = await prisma.$transaction([
      prisma.egressRule.update({
        where: { id: ruleWithPolicy.id },
        data: {
          ...(pattern !== undefined ? { pattern } : {}),
          ...(action !== undefined ? { action } : {}),
          ...(targets !== undefined ? { targets: targets as unknown as runtime.InputJsonValue } : {}),
          updatedBy: userId,
        },
      }),
      prisma.egressPolicy.update({
        where: { id: policy.id },
        data: {
          version: policy.version + 1,
          updatedBy: userId,
        },
      }),
    ]);

    logger.info({ policyId: policy.id, ruleId: ruleWithPolicy.id, userId }, 'egress rule updated');
    emitEgressRuleMutation({
      policy: updatedPolicyAfterPatch,
      ruleId: updated.id,
      changeType: 'updated',
      rule: updated,
    });
    fireAndForgetPush(policy.id);

    return res.json(serializeRule(updated));
  }),
);

// DELETE /api/egress/rules/:ruleId — hard delete
// Response: 204 No Content
router.delete(
  '/rules/:ruleId',
  requirePermission('egress:write'),
  asyncHandler(async (req, res) => {
    const ruleWithPolicy = await prisma.egressRule.findUnique({
      where: { id: String(req.params.ruleId) },
      include: { policy: true },
    });

    if (!ruleWithPolicy) {
      return res.status(404).json({ error: 'Not Found', message: 'Egress rule not found' });
    }

    const { policy } = ruleWithPolicy;

    if (policy.archivedAt !== null) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Cannot delete a rule belonging to an archived egress policy',
      });
    }

    const userId = getUserId(req) ?? null;

    const [, updatedPolicyAfterDelete] = await prisma.$transaction([
      prisma.egressRule.delete({ where: { id: ruleWithPolicy.id } }),
      prisma.egressPolicy.update({
        where: { id: policy.id },
        data: {
          version: policy.version + 1,
          updatedBy: userId,
        },
      }),
    ]);

    logger.info({ policyId: policy.id, ruleId: ruleWithPolicy.id, userId }, 'egress rule deleted');
    emitEgressRuleMutation({
      policy: updatedPolicyAfterDelete,
      ruleId: ruleWithPolicy.id,
      changeType: 'deleted',
      rule: null,
    });
    fireAndForgetPush(policy.id);

    return res.status(204).send();
  }),
);

// ===========================================================================
// EVENTS
// ===========================================================================

const eventQuerySchema = z.object({
  action: z.enum(['allowed', 'blocked', 'observed']).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  environmentId: z.string().optional(),
  stackId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// GET /api/egress/policies/:policyId/events
// Query: action, since (ISO8601), until (ISO8601), page, limit
// Response: { events, total, page, limit, totalPages, hasNextPage, hasPreviousPage }
router.get(
  '/policies/:policyId/events',
  requirePermission('egress:read'),
  asyncHandler(async (req, res) => {
    const policy = await prisma.egressPolicy.findUnique({
      where: { id: String(req.params.policyId) },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Not Found', message: 'Egress policy not found' });
    }

    const parsed = eventQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid query parameters',
        details: parsed.error.issues,
      });
    }

    const { action, since, until, page, limit } = parsed.data;

    const where = {
      policyId: policy.id,
      ...(action ? { action } : {}),
      ...(since || until
        ? {
            occurredAt: {
              ...(since ? { gte: new Date(since) } : {}),
              ...(until ? { lte: new Date(until) } : {}),
            },
          }
        : {}),
    };

    const [events, total] = await Promise.all([
      prisma.egressEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          policy: {
            select: { stackNameSnapshot: true, environmentNameSnapshot: true, environmentId: true },
          },
        },
      }),
      prisma.egressEvent.count({ where }),
    ]);

    return res.json({
      ...buildPaginationMeta(total, page, limit),
      events: events.map(serializeEvent),
    });
  }),
);

// GET /api/egress/events — cross-policy listing
// Query: action, since, until, environmentId, stackId, page, limit
// Response: { events, total, page, limit, totalPages, hasNextPage, hasPreviousPage }
router.get(
  '/events',
  requirePermission('egress:read'),
  asyncHandler(async (req, res) => {
    const parsed = eventQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid query parameters',
        details: parsed.error.issues,
      });
    }

    const { action, since, until, environmentId, stackId, page, limit } = parsed.data;

    // If filtering by environmentId or stackId, filter via the nested policy
    const hasPolicyFilter = !!(environmentId || stackId);
    const policyWhere = {
      ...(environmentId ? { environmentId } : {}),
      ...(stackId ? { stackId } : {}),
    };

    const where = {
      ...(hasPolicyFilter ? { policy: policyWhere } : {}),
      ...(action ? { action } : {}),
      ...(since || until
        ? {
            occurredAt: {
              ...(since ? { gte: new Date(since) } : {}),
              ...(until ? { lte: new Date(until) } : {}),
            },
          }
        : {}),
    };

    const [events, total] = await Promise.all([
      prisma.egressEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          policy: {
            select: { stackNameSnapshot: true, environmentNameSnapshot: true, environmentId: true },
          },
        },
      }),
      prisma.egressEvent.count({ where }),
    ]);

    return res.json({
      ...buildPaginationMeta(total, page, limit),
      events: events.map(serializeEvent),
    });
  }),
);

export default router;
