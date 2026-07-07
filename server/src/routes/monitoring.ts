import { existsSync } from 'fs';
import { Router } from 'express';
import { requirePermission } from '../middleware/auth';
import { asyncHandler } from '../lib/async-handler';
import prisma from '../lib/prisma';
import { getLogger } from '../lib/logger-factory';
import { MonitoringStatusResponse, Permission, ErrorCode } from '@mini-infra/types';
import { DockerExecutorService } from '../services/docker-executor';
import { StackReconciler } from '../services/stacks/stack-reconciler';
import { serializeStack, mapContainerStatus, isDockerConnectionError } from '../services/stacks/utils';
import { getStackProjectName } from '../services/stacks/template-engine';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';

const router = Router();
const logger = getLogger("platform", "monitoring");

// When the server runs inside Docker, reach Prometheus/Loki by their container
// names on the shared monitoring network. The names must match exactly what the
// stack reconciler creates for the host-scoped `monitoring` stack — project
// `mini-infra-monitoring`, so containers `mini-infra-monitoring-{prometheus,loki}`.
// When running on the host, use localhost with the published ports.
const MONITORING_PROJECT = getStackProjectName({ name: 'monitoring', environment: null });
const inDocker = existsSync('/.dockerenv');
const PROMETHEUS_URL = inDocker ? `http://${MONITORING_PROJECT}-prometheus:9090` : 'http://localhost:9090';
const LOKI_URL = inDocker ? `http://${MONITORING_PROJECT}-loki:3100` : 'http://localhost:3100';

async function getMonitoringStack() {
  return prisma.stack.findFirst({
    where: { name: 'monitoring', environmentId: null, status: { not: 'removed' } },
    include: { services: { orderBy: { order: 'asc' } } },
  });
}

// GET /api/monitoring/status - Get monitoring stack status
router.get(
  '/status',
  requirePermission(Permission.MonitoringRead),
  asyncHandler(async (_req, res) => {
    const stack = await getMonitoringStack();

    if (!stack) {
      return res.json({
        stack: null,
        containerStatus: [],
        running: false,
        message: 'Monitoring stack not found. It will be created on next server restart.',
      });
    }

    let containerStatus: MonitoringStatusResponse['containerStatus'] = [];
    let running = false;
    try {
      const dockerExecutor = new DockerExecutorService();
      await dockerExecutor.initialize();
      const docker = dockerExecutor.getDockerClient();
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack=${stack.name}`] },
      });

      containerStatus = containers.map(mapContainerStatus);

      // Check if prometheus is actually running via its container label
      running = containers.some(
        (c) =>
          c.Labels['mini-infra.service'] === 'prometheus' &&
          c.State === 'running'
      );
    } catch {
      // Docker unavailable
    }

    const response: MonitoringStatusResponse = {
      stack: serializeStack(stack),
      containerStatus,
      running,
    };
    res.json(response);
  }),
);

// POST /api/monitoring/stop - Stop monitoring stack
router.post(
  '/stop',
  requirePermission(Permission.MonitoringWrite),
  asyncHandler(async (req, res) => {
    const stack = await getMonitoringStack();
    if (!stack) {
      throw new NotFoundError(
        ErrorCode.MONITORING_STACK_NOT_FOUND,
        'Monitoring stack not found',
        { resource: { type: 'stack', name: 'monitoring' } },
      );
    }

    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    const reconciler = new StackReconciler(dockerExecutor, prisma);
    const result = await reconciler.stopStack(stack.id, { triggeredBy: (req as { user?: { id?: string } }).user?.id });

    res.json({ message: 'Monitoring stack stopped', ...result });
  }),
);

function throwIfDockerConnectionError(error: unknown): void {
  if (isDockerConnectionError(error)) {
    throw new ConflictError(
      ErrorCode.MONITORING_SERVICE_UNAVAILABLE,
      'Monitoring service is not running',
      {
        resource: { type: 'stack', name: 'monitoring' },
        action: 'Start the monitoring stack, then retry.',
      },
    );
  }
}

// GET /api/monitoring/query - Proxy instant query to Prometheus
router.get(
  '/query',
  requirePermission(Permission.MonitoringRead),
  asyncHandler(async (req, res) => {
    const { query, time } = req.query;

    if (!query || typeof query !== 'string') {
      throw new ValidationError(
        ErrorCode.MONITORING_QUERY_PARAM_MISSING,
        'query parameter is required',
      );
    }

    const params = new URLSearchParams({ query });
    if (time && typeof time === 'string') params.set('time', time);

    try {
      const response = await fetch(`${PROMETHEUS_URL}/api/v1/query?${params}`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      throwIfDockerConnectionError(error);
      logger.error({ error }, 'Failed to query Prometheus');
      throw error;
    }
  }),
);

// GET /api/monitoring/query_range - Proxy range query to Prometheus
router.get(
  '/query_range',
  requirePermission(Permission.MonitoringRead),
  asyncHandler(async (req, res) => {
    const { query, start, end, step } = req.query;

    if (!query || typeof query !== 'string') {
      throw new ValidationError(
        ErrorCode.MONITORING_QUERY_PARAM_MISSING,
        'query parameter is required',
      );
    }
    if (!start || typeof start !== 'string') {
      throw new ValidationError(
        ErrorCode.MONITORING_QUERY_PARAM_MISSING,
        'start parameter is required',
      );
    }
    if (!end || typeof end !== 'string') {
      throw new ValidationError(
        ErrorCode.MONITORING_QUERY_PARAM_MISSING,
        'end parameter is required',
      );
    }

    const params = new URLSearchParams({ query, start, end });
    if (step && typeof step === 'string') params.set('step', step);
    else params.set('step', '15s');

    try {
      const response = await fetch(`${PROMETHEUS_URL}/api/v1/query_range?${params}`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      throwIfDockerConnectionError(error);
      logger.error({ error }, 'Failed to query Prometheus range');
      throw error;
    }
  }),
);

// GET /api/monitoring/targets - Proxy targets query to Prometheus
router.get(
  '/targets',
  requirePermission(Permission.MonitoringRead),
  asyncHandler(async (_req, res) => {
    try {
      const response = await fetch(`${PROMETHEUS_URL}/api/v1/targets`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      throwIfDockerConnectionError(error);
      logger.error({ error }, 'Failed to query Prometheus targets');
      throw error;
    }
  }),
);

// ============================================================
// Loki log query proxy routes
// ============================================================

// GET /api/monitoring/loki/labels - List all label names
router.get(
  '/loki/labels',
  requirePermission(Permission.MonitoringRead),
  asyncHandler(async (req, res) => {
    const params = new URLSearchParams();
    const { start, end } = req.query;
    if (start && typeof start === 'string') params.set('start', start);
    if (end && typeof end === 'string') params.set('end', end);

    try {
      const response = await fetch(`${LOKI_URL}/loki/api/v1/labels?${params}`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      throwIfDockerConnectionError(error);
      logger.error({ error }, 'Failed to query Loki labels');
      throw error;
    }
  }),
);

// GET /api/monitoring/loki/label/:name/values - List values for a label
router.get(
  '/loki/label/:name/values',
  requirePermission(Permission.MonitoringRead),
  asyncHandler(async (req, res) => {
    const params = new URLSearchParams();
    const { start, end } = req.query;
    if (start && typeof start === 'string') params.set('start', start);
    if (end && typeof end === 'string') params.set('end', end);

    try {
      const response = await fetch(`${LOKI_URL}/loki/api/v1/label/${encodeURIComponent(String(req.params.name))}/values?${params}`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      throwIfDockerConnectionError(error);
      logger.error({ error }, 'Failed to query Loki label values');
      throw error;
    }
  }),
);

// GET /api/monitoring/loki/query_range - Query logs over a time range
router.get(
  '/loki/query_range',
  requirePermission(Permission.MonitoringRead),
  asyncHandler(async (req, res) => {
    const { query, start, end, limit, direction } = req.query;

    if (!query || typeof query !== 'string') {
      throw new ValidationError(
        ErrorCode.MONITORING_QUERY_PARAM_MISSING,
        'query parameter is required',
      );
    }

    const params = new URLSearchParams({ query });
    if (start && typeof start === 'string') params.set('start', start);
    if (end && typeof end === 'string') params.set('end', end);
    if (limit && typeof limit === 'string') params.set('limit', limit);
    if (direction && typeof direction === 'string') params.set('direction', direction);

    try {
      const response = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      throwIfDockerConnectionError(error);
      logger.error({ error }, 'Failed to query Loki logs');
      throw error;
    }
  }),
);

// GET /api/monitoring/loki/query - Query logs at a single point in time
router.get(
  '/loki/query',
  requirePermission(Permission.MonitoringRead),
  asyncHandler(async (req, res) => {
    const { query, time, limit, direction } = req.query;

    if (!query || typeof query !== 'string') {
      throw new ValidationError(
        ErrorCode.MONITORING_QUERY_PARAM_MISSING,
        'query parameter is required',
      );
    }

    const params = new URLSearchParams({ query });
    if (time && typeof time === 'string') params.set('time', time);
    if (limit && typeof limit === 'string') params.set('limit', limit);
    if (direction && typeof direction === 'string') params.set('direction', direction);

    try {
      const response = await fetch(`${LOKI_URL}/loki/api/v1/query?${params}`);
      const data = await response.json();
      res.json(data);
    } catch (error) {
      throwIfDockerConnectionError(error);
      logger.error({ error }, 'Failed to query Loki');
      throw error;
    }
  }),
);

export default router;
