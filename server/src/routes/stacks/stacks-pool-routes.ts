import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { PoolConfig, PoolInstanceInfo, PoolInstance as PoolInstanceDb } from '@mini-infra/types';
import { hasAnyPermission } from '@mini-infra/types';
import prisma from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { requireSessionOrApiKey } from '../../middleware/auth';
import { getLogger } from '../../lib/logger-factory';
import { DockerExecutorService } from '../../services/docker-executor';
import { verifyPoolManagementToken } from '../../services/stacks/pool-management-token';
import { spawnPoolInstance } from '../../services/stacks/pool-spawner';
import {
  emitPoolInstanceStarting,
  emitPoolInstanceStarted,
  emitPoolInstanceFailed,
  emitPoolInstanceStopped,
} from '../../services/stacks/pool-socket-emitter';

/**
 * Build an initialised DockerExecutorService for a single request. Mirrors
 * what other stack routes (validation, history, crud) already do — the
 * underlying Docker client is a singleton, so this is cheap.
 */
async function buildDockerExecutor(): Promise<DockerExecutorService> {
  const executor = new DockerExecutorService();
  await executor.initialize();
  return executor;
}

const log = getLogger('stacks', 'stacks-pool-routes');
const router = Router();

const ensureInstanceSchema = z.object({
  instanceId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'instanceId must be alphanumeric with dots, dashes, and underscores'),
  env: z.record(z.string(), z.string()).optional(),
  idleTimeoutMinutes: z.number().int().min(1).max(24 * 60).optional(),
});

/**
 * Middleware: accept either an API key with the required scope OR a pool
 * management token bound to this specific `(stackId, serviceName)`. Resolves
 * to one of those two — anonymous requests get a 401.
 */
function requirePoolAccess(requiredScope: 'pools:read' | 'pools:write') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);

    // Path 1 — pool management token. Accepted only when the bearer matches
    // the hash stored on the addressed Pool service.
    const authHeader = req.header('authorization') || req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim();
      const candidates = await prisma.stackService.findMany({
        where: {
          stackId,
          serviceName,
          serviceType: 'Pool',
          NOT: { poolManagementTokenHash: null },
        },
        select: { id: true, poolManagementTokenHash: true },
      });
      for (const c of candidates) {
        if (!c.poolManagementTokenHash) continue;
        if (await verifyPoolManagementToken(token, c.poolManagementTokenHash)) {
          next();
          return;
        }
      }
      // Bearer present but didn't match any token for this pool — do NOT
      // fall through to session/API-key auth. An in-stack caller passing a
      // bad token is a genuine auth failure.
      res.status(401).json({ success: false, message: 'Invalid pool management token' });
      return;
    }

    // Path 2 — session or API key with the right permission.
    await new Promise<void>((resolve) => {
      requireSessionOrApiKey(req, res, () => resolve());
    });
    if (res.headersSent) return;

    // Session users have full access.
    if (req.user && !req.apiKey) {
      next();
      return;
    }

    if (req.apiKey) {
      if (!hasAnyPermission(req.apiKey.permissions, [requiredScope])) {
        res.status(403).json({
          success: false,
          message: `Missing required permission: ${requiredScope}`,
        });
        return;
      }
      next();
      return;
    }

    res.status(401).json({ success: false, message: 'Authentication required' });
  };
}

/**
 * Resolve the pool service + config. 404 if the stack/service doesn't exist
 * or the service isn't a Pool-type.
 */
async function resolvePoolService(stackId: string, serviceName: string) {
  const svc = await prisma.stackService.findFirst({
    where: { stackId, serviceName, serviceType: 'Pool' },
  });
  if (!svc) return null;
  return { service: svc, poolConfig: svc.poolConfig as unknown as PoolConfig | null };
}

function serializeInstance(row: PoolInstanceDb): PoolInstanceInfo {
  return {
    id: row.id,
    stackId: row.stackId,
    serviceName: row.serviceName,
    instanceId: row.instanceId,
    containerId: row.containerId,
    status: row.status,
    idleTimeoutMinutes: row.idleTimeoutMinutes,
    lastActive: row.lastActive.toISOString(),
    createdAt: row.createdAt.toISOString(),
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
  };
}

// POST / — Ensure a pool instance exists (synchronous spawn in Phase 1).
router.post(
  '/:stackId/pools/:serviceName/instances',
  requirePoolAccess('pools:write'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);

    const parsed = ensureInstanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        issues: parsed.error.issues,
      });
    }

    const resolved = await resolvePoolService(stackId, serviceName);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Pool service not found' });
    }
    const { service, poolConfig } = resolved;
    if (!poolConfig) {
      return res.status(400).json({ success: false, message: 'Pool service missing poolConfig' });
    }

    const { instanceId, env, idleTimeoutMinutes } = parsed.data;
    const effectiveIdle = idleTimeoutMinutes ?? poolConfig.defaultIdleTimeoutMinutes;

    // Idempotency: if there's already an active (starting/running) row, return it.
    const existing = await prisma.poolInstance.findFirst({
      where: { stackId, serviceName, instanceId, status: { in: ['starting', 'running'] } },
    });
    if (existing) {
      return res.json({ success: true, data: serializeInstance(existing as unknown as PoolInstanceDb) });
    }

    // Enforce maxInstances.
    if (poolConfig.maxInstances !== null) {
      const activeCount = await prisma.poolInstance.count({
        where: { stackId, serviceName, status: { in: ['starting', 'running'] } },
      });
      if (activeCount >= poolConfig.maxInstances) {
        return res.status(409).json({
          success: false,
          message: `Pool has reached maxInstances=${poolConfig.maxInstances}`,
        });
      }
    }

    // Fetch stack for naming context.
    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      include: { environment: true },
    });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }
    if (stack.status === 'error') {
      return res
        .status(409)
        .json({ success: false, message: 'Cannot spawn into a stack in error state' });
    }

    // Insert starting row.
    let row;
    try {
      row = await prisma.poolInstance.create({
        data: {
          stackId,
          serviceName,
          instanceId,
          status: 'starting',
          idleTimeoutMinutes: effectiveIdle,
        },
      });
    } catch (err) {
      // Partial unique index race — another request is already spawning.
      const existingAfter = await prisma.poolInstance.findFirst({
        where: { stackId, serviceName, instanceId, status: { in: ['starting', 'running'] } },
      });
      if (existingAfter) {
        return res.json({ success: true, data: serializeInstance(existingAfter as unknown as PoolInstanceDb) });
      }
      log.error({ stackId, serviceName, instanceId, err }, 'Failed to insert pool instance row');
      return res.status(500).json({ success: false, message: 'Failed to reserve pool instance' });
    }

    // Emit starting event + respond immediately. Spawn runs in the
    // background; callers observe progress via pool:instance:* events or by
    // polling GET /:instanceId.
    emitPoolInstanceStarting({ stackId, serviceName, instanceId });

    res.status(202).json({
      success: true,
      data: serializeInstance(row as unknown as PoolInstanceDb),
    });

    void spawnInBackground({
      stackId,
      stackName: stack.name,
      environmentName: stack.environment?.name ?? null,
      environmentId: stack.environmentId,
      serviceName,
      instanceId,
      rowId: row.id,
      callerEnv: env ?? {},
      idleTimeoutMinutes: effectiveIdle,
    });

    // `service` is referenced only for future extension (e.g. audit logging
    // of which pool service configuration was used).
    void service;
  }),
);

interface SpawnBgArgs {
  stackId: string;
  stackName: string;
  environmentName: string | null;
  environmentId: string | null;
  serviceName: string;
  instanceId: string;
  rowId: string;
  callerEnv: Record<string, string>;
  idleTimeoutMinutes: number;
}

async function spawnInBackground(args: SpawnBgArgs): Promise<void> {
  const { stackId, serviceName, instanceId, rowId } = args;
  try {
    const dockerExecutor = await buildDockerExecutor();
    const result = await spawnPoolInstance(prisma, dockerExecutor, {
      stackId,
      stackName: args.stackName,
      environmentName: args.environmentName,
      environmentId: args.environmentId,
      serviceName,
      instanceId,
      instanceRowId: rowId,
      callerEnv: args.callerEnv,
      idleTimeoutMinutes: args.idleTimeoutMinutes,
    });

    if (!result.success) {
      await prisma.poolInstance.update({
        where: { id: rowId },
        data: {
          status: 'error',
          errorMessage: result.error ?? 'Unknown spawn error',
          stoppedAt: new Date(),
          containerId: result.containerId ?? null,
        },
      }).catch((err) => {
        log.error({ rowId, err }, 'Failed to update pool instance row to error');
      });
      log.warn({ stackId, serviceName, instanceId, error: result.error }, 'Pool spawn failed');
      emitPoolInstanceFailed({
        stackId,
        serviceName,
        instanceId,
        error: result.error ?? 'Unknown spawn error',
      });
      return;
    }

    await prisma.poolInstance.update({
      where: { id: rowId },
      data: {
        status: 'running',
        containerId: result.containerId,
        lastActive: new Date(),
      },
    });
    emitPoolInstanceStarted({
      stackId,
      serviceName,
      instanceId,
      containerId: result.containerId!,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ stackId, serviceName, instanceId, err: msg }, 'Pool spawn threw unexpectedly');
    await prisma.poolInstance.update({
      where: { id: rowId },
      data: { status: 'error', errorMessage: msg, stoppedAt: new Date() },
    }).catch(() => { /* already logged */ });
    emitPoolInstanceFailed({ stackId, serviceName, instanceId, error: msg });
  }
}

// GET / — List active instances (starting/running).
router.get(
  '/:stackId/pools/:serviceName/instances',
  requirePoolAccess('pools:read'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);

    const resolved = await resolvePoolService(stackId, serviceName);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Pool service not found' });
    }

    const rows = await prisma.poolInstance.findMany({
      where: {
        stackId,
        serviceName,
        status: { in: ['starting', 'running', 'stopping'] },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      success: true,
      data: rows.map((r) => serializeInstance(r as unknown as PoolInstanceDb)),
    });
  }),
);

// GET /:instanceId — Get a specific instance (active only).
router.get(
  '/:stackId/pools/:serviceName/instances/:instanceId',
  requirePoolAccess('pools:read'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);
    const instanceId = String(req.params.instanceId);

    const resolved = await resolvePoolService(stackId, serviceName);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Pool service not found' });
    }

    const row = await prisma.poolInstance.findFirst({
      where: { stackId, serviceName, instanceId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      return res.status(404).json({ success: false, message: 'Instance not found' });
    }
    res.json({ success: true, data: serializeInstance(row as unknown as PoolInstanceDb) });
  }),
);

// DELETE /:instanceId — Stop and remove the instance.
router.delete(
  '/:stackId/pools/:serviceName/instances/:instanceId',
  requirePoolAccess('pools:write'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);
    const instanceId = String(req.params.instanceId);

    const resolved = await resolvePoolService(stackId, serviceName);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Pool service not found' });
    }

    const row = await prisma.poolInstance.findFirst({
      where: { stackId, serviceName, instanceId, status: { in: ['starting', 'running', 'stopping'] } },
    });
    if (!row) {
      return res.status(404).json({ success: false, message: 'Active instance not found' });
    }

    await prisma.poolInstance.update({
      where: { id: row.id },
      data: { status: 'stopped', stoppedAt: new Date() },
    });

    // Fire-and-forget container cleanup — the caller doesn't wait.
    if (row.containerId) {
      const dockerExecutor = await buildDockerExecutor();
      const docker = dockerExecutor.getDockerClient();
      const containerId = row.containerId;
      void (async () => {
        try {
          const container = docker.getContainer(containerId);
          await container.stop({ t: 10 }).catch((err) => {
            const code = (err as { statusCode?: number })?.statusCode;
            if (code !== 404 && code !== 304) throw err;
          });
          await container.remove({ force: true }).catch((err) => {
            const code = (err as { statusCode?: number })?.statusCode;
            if (code !== 404) throw err;
          });
        } catch (err) {
          log.warn(
            { stackId, serviceName, instanceId, err: err instanceof Error ? err.message : String(err) },
            'Fire-and-forget container removal failed',
          );
        }
      })();
    }

    emitPoolInstanceStopped({ stackId, serviceName, instanceId });

    res.json({
      success: true,
      data: { id: row.id, status: 'stopped' },
    });
  }),
);

// POST /:instanceId/heartbeat — refresh lastActive for a running instance.
router.post(
  '/:stackId/pools/:serviceName/instances/:instanceId/heartbeat',
  requirePoolAccess('pools:write'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);
    const instanceId = String(req.params.instanceId);

    const resolved = await resolvePoolService(stackId, serviceName);
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Pool service not found' });
    }

    const row = await prisma.poolInstance.findFirst({
      where: {
        stackId,
        serviceName,
        instanceId,
        status: { in: ['starting', 'running'] },
      },
    });
    if (!row) {
      return res.status(404).json({ success: false, message: 'Active instance not found' });
    }

    const now = new Date();
    await prisma.poolInstance.update({
      where: { id: row.id },
      data: { lastActive: now },
    });

    const expiresAt = new Date(now.getTime() + row.idleTimeoutMinutes * 60 * 1000);
    res.json({
      ok: true,
      lastActive: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  }),
);

export default router;
