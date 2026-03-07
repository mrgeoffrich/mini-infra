import { Router } from 'express';
import { requirePermission } from '../middleware/auth';
import prisma from '../lib/prisma';
import { appLogger } from '../lib/logger-factory';
import { DockerExecutorService } from '../services/docker-executor';
import { StackReconciler } from '../services/stacks/stack-reconciler';
import type { StackInfo } from '@mini-infra/types';

const router = Router();
const logger = appLogger();

const PROMETHEUS_URL = 'http://localhost:9090';
const LOKI_URL = 'http://localhost:3100';

function serializeStack(stack: any): StackInfo {
  return {
    ...stack,
    lastAppliedAt: stack.lastAppliedAt?.toISOString() ?? null,
    createdAt: stack.createdAt.toISOString(),
    updatedAt: stack.updatedAt.toISOString(),
    services: stack.services?.map((svc: any) => ({
      ...svc,
      createdAt: svc.createdAt.toISOString(),
      updatedAt: svc.updatedAt.toISOString(),
    })),
  };
}

async function getMonitoringStack() {
  return prisma.stack.findFirst({
    where: { name: 'monitoring', environmentId: null },
    include: { services: { orderBy: { order: 'asc' } } },
  });
}

function isMonitoringRunning(stack: { status: string } | null): boolean {
  return stack?.status === 'synced';
}

// GET /api/monitoring/status - Get monitoring stack status
router.get('/status', requirePermission('monitoring:read'), async (_req, res) => {
  try {
    const stack = await getMonitoringStack();

    if (!stack) {
      return res.json({
        stack: null,
        running: false,
        message: 'Monitoring stack not found. It will be created on next server restart.',
      });
    }

    let containerStatus: any[] = [];
    try {
      const dockerExecutor = new DockerExecutorService();
      const docker = dockerExecutor.getDockerClient();
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack-id=${stack.id}`] },
      });

      containerStatus = containers.map((c) => ({
        serviceName: c.Labels['mini-infra.service'] ?? 'unknown',
        containerId: c.Id,
        containerName: c.Names?.[0]?.replace(/^\//, '') ?? '',
        image: c.Image,
        state: c.State,
        status: c.Status,
      }));
    } catch {
      // Docker unavailable
    }

    const running = isMonitoringRunning(stack) && containerStatus.some((c) => c.state === 'running');

    res.json({
      stack: serializeStack(stack),
      containerStatus,
      running,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get monitoring status');
    res.status(500).json({ error: 'Failed to get monitoring status' });
  }
});

// POST /api/monitoring/stop - Stop monitoring stack
router.post('/stop', requirePermission('monitoring:write'), async (_req, res) => {
  try {
    const stack = await getMonitoringStack();
    if (!stack) {
      return res.status(404).json({ error: 'Monitoring stack not found' });
    }

    const dockerExecutor = new DockerExecutorService();
    const reconciler = new StackReconciler(dockerExecutor, prisma);
    const result = await reconciler.stopStack(stack.id);

    res.json({ message: 'Monitoring stack stopped', ...result });
  } catch (error: any) {
    logger.error({ error }, 'Failed to stop monitoring stack');
    res.status(500).json({ error: error?.message ?? 'Failed to stop monitoring stack' });
  }
});

function isConnectionError(error: unknown): boolean {
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = (error as any).cause;
    return cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET' || cause?.code === 'ENOTFOUND';
  }
  return false;
}

// GET /api/monitoring/query - Proxy instant query to Prometheus
router.get('/query', requirePermission('monitoring:read'), async (req, res) => {
  try {
    const { query, time } = req.query;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query parameter is required' });
    }

    const params = new URLSearchParams({ query });
    if (time && typeof time === 'string') params.set('time', time);

    const response = await fetch(`${PROMETHEUS_URL}/api/v1/query?${params}`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Prometheus');
    res.status(500).json({ error: 'Failed to query Prometheus' });
  }
});

// GET /api/monitoring/query_range - Proxy range query to Prometheus
router.get('/query_range', requirePermission('monitoring:read'), async (req, res) => {
  try {
    const { query, start, end, step } = req.query;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query parameter is required' });
    }
    if (!start || typeof start !== 'string') {
      return res.status(400).json({ error: 'start parameter is required' });
    }
    if (!end || typeof end !== 'string') {
      return res.status(400).json({ error: 'end parameter is required' });
    }

    const params = new URLSearchParams({ query, start, end });
    if (step && typeof step === 'string') params.set('step', step);
    else params.set('step', '15s');

    const response = await fetch(`${PROMETHEUS_URL}/api/v1/query_range?${params}`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Prometheus range');
    res.status(500).json({ error: 'Failed to query Prometheus' });
  }
});

// GET /api/monitoring/targets - Proxy targets query to Prometheus
router.get('/targets', requirePermission('monitoring:read'), async (_req, res) => {
  try {
    const response = await fetch(`${PROMETHEUS_URL}/api/v1/targets`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Prometheus targets');
    res.status(500).json({ error: 'Failed to query Prometheus targets' });
  }
});

// ============================================================
// Loki log query proxy routes
// ============================================================

// GET /api/monitoring/loki/labels - List all label names
router.get('/loki/labels', requirePermission('monitoring:read'), async (req, res) => {
  try {
    const params = new URLSearchParams();
    const { start, end } = req.query;
    if (start && typeof start === 'string') params.set('start', start);
    if (end && typeof end === 'string') params.set('end', end);

    const response = await fetch(`${LOKI_URL}/loki/api/v1/labels?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Loki labels');
    res.status(500).json({ error: 'Failed to query Loki labels' });
  }
});

// GET /api/monitoring/loki/label/:name/values - List values for a label
router.get('/loki/label/:name/values', requirePermission('monitoring:read'), async (req, res) => {
  try {
    const params = new URLSearchParams();
    const { start, end } = req.query;
    if (start && typeof start === 'string') params.set('start', start);
    if (end && typeof end === 'string') params.set('end', end);

    const response = await fetch(`${LOKI_URL}/loki/api/v1/label/${encodeURIComponent(req.params.name)}/values?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Loki label values');
    res.status(500).json({ error: 'Failed to query Loki label values' });
  }
});

// GET /api/monitoring/loki/query_range - Query logs over a time range
router.get('/loki/query_range', requirePermission('monitoring:read'), async (req, res) => {
  try {
    const { query, start, end, limit, direction } = req.query;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query parameter is required' });
    }

    const params = new URLSearchParams({ query });
    if (start && typeof start === 'string') params.set('start', start);
    if (end && typeof end === 'string') params.set('end', end);
    if (limit && typeof limit === 'string') params.set('limit', limit);
    if (direction && typeof direction === 'string') params.set('direction', direction);

    const response = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Loki logs');
    res.status(500).json({ error: 'Failed to query Loki logs' });
  }
});

// GET /api/monitoring/loki/query - Query logs at a single point in time
router.get('/loki/query', requirePermission('monitoring:read'), async (req, res) => {
  try {
    const { query, time, limit, direction } = req.query;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query parameter is required' });
    }

    const params = new URLSearchParams({ query });
    if (time && typeof time === 'string') params.set('time', time);
    if (limit && typeof limit === 'string') params.set('limit', limit);
    if (direction && typeof direction === 'string') params.set('direction', direction);

    const response = await fetch(`${LOKI_URL}/loki/api/v1/query?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Loki');
    res.status(500).json({ error: 'Failed to query Loki' });
  }
});

export default router;
