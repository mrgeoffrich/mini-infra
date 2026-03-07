import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { requirePermission } from '../middleware/auth';
import { MonitoringService } from '../services/monitoring';
import { ApplicationServiceFactory } from '../services/application-service-factory';
import { ServiceRegistry } from '../services/environment';
import prisma from '../lib/prisma';
import { appLogger } from '../lib/logger-factory';

const router = Router();
const logger = appLogger();
const serviceFactory = ApplicationServiceFactory.getInstance();
const serviceRegistry = ServiceRegistry.getInstance();

const MONITORING_SERVICE_NAME = 'host-monitoring';
const MONITORING_SERVICE_TYPE = 'monitoring';

/**
 * Get the MonitoringService instance from the factory, or create a temporary one
 * if the containers are running but the server was restarted (factory is empty).
 */
async function getOrRecoverService(): Promise<MonitoringService | undefined> {
  const existing = serviceFactory.getService(MONITORING_SERVICE_NAME) as MonitoringService | undefined;
  if (existing) return existing;

  // Check if DB says running — containers may still be up after a server restart
  const dbRecord = await prisma.hostService.findUnique({
    where: { serviceName: MONITORING_SERVICE_NAME }
  });

  if (dbRecord?.status !== 'running') return undefined;

  // Re-create the service instance and register it in the factory
  try {
    const metadata = serviceRegistry.getServiceMetadata(MONITORING_SERVICE_TYPE);
    const networks = metadata?.requiredNetworks || [];
    const volumes = metadata?.requiredVolumes || [];

    const createResult = await serviceFactory.createService({
      serviceName: MONITORING_SERVICE_NAME,
      serviceType: MONITORING_SERVICE_TYPE,
      projectName: 'monitoring'
    });

    if (!createResult.success || !createResult.service) return undefined;

    await createResult.service.initialize(networks, volumes);

    // Verify containers are actually healthy before promoting
    const monitoringService = createResult.service as MonitoringService;
    const health = await monitoringService.healthCheck();
    if (health.status !== 'healthy') {
      await serviceFactory.stopService(MONITORING_SERVICE_NAME).catch(() => {});
      // Update DB so we don't keep retrying recovery on every request
      await prisma.hostService.update({
        where: { serviceName: MONITORING_SERVICE_NAME },
        data: { status: 'stopped', health: 'unknown', stoppedAt: new Date() }
      }).catch(() => {});
      return undefined;
    }

    // Mark as running since containers are already up
    monitoringService.markAsRunning();

    logger.info('Recovered monitoring service instance after server restart');
    return monitoringService;
  } catch (error) {
    logger.info({ error }, 'Monitoring containers not reachable, marking as stopped');
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: { status: 'stopped', health: 'unknown', stoppedAt: new Date() }
    }).catch(() => {});
    return undefined;
  }
}

async function getOrCreateDbRecord() {
  let record = await prisma.hostService.findUnique({
    where: { serviceName: MONITORING_SERVICE_NAME }
  });

  if (!record) {
    record = await prisma.hostService.create({
      data: {
        serviceName: MONITORING_SERVICE_NAME,
        serviceType: MONITORING_SERVICE_TYPE,
        status: 'stopped',
        health: 'unknown'
      }
    });
  }

  return record;
}

// GET /api/monitoring/status - Get monitoring service status
router.get('/status', requirePermission('monitoring:read'), async (_req, res) => {
  try {
    const dbRecord = await getOrCreateDbRecord();

    // Try to get live status from running service (or recover after restart)
    const service = await getOrRecoverService();
    if (service) {
      const status = await service.getStatus();
      return res.json({
        service: {
          ...dbRecord,
          status: status.status,
          health: status.health.status
        },
        metadata: status.metadata,
        healthDetails: status.health,
        lastError: status.lastError
      });
    }

    // Service not in factory - return DB state
    const metadata = serviceRegistry.getServiceMetadata(MONITORING_SERVICE_TYPE);
    res.json({
      service: dbRecord,
      metadata,
      healthDetails: {
        status: dbRecord.health,
        message: dbRecord.status === 'stopped' ? 'Service is stopped' : 'Service state unknown',
        lastChecked: new Date()
      },
      lastError: dbRecord.lastError
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get monitoring status');
    res.status(500).json({ error: 'Failed to get monitoring status' });
  }
});

// POST /api/monitoring/start - Start the monitoring service
router.post('/start', requirePermission('monitoring:write'), async (_req, res) => {
  try {
    const dbRecord = await getOrCreateDbRecord();

    // If DB says running, verify containers are actually running
    if (dbRecord.status === 'running') {
      const service = serviceFactory.getService(MONITORING_SERVICE_NAME) as MonitoringService | undefined;
      if (service) {
        const health = await service.healthCheck();
        if (health.status === 'healthy') {
          return res.status(400).json({ error: 'Monitoring service is already running' });
        }
        // Containers are gone or unhealthy — clean up stale factory entry and re-deploy
        logger.info('DB shows running but containers are unhealthy, re-deploying');
        await serviceFactory.stopService(MONITORING_SERVICE_NAME).catch(() => {});
      }
    }

    // Update DB status to starting
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: { status: 'starting', lastError: Prisma.JsonNull }
    });

    // Create service via factory
    const createResult = await serviceFactory.createService({
      serviceName: MONITORING_SERVICE_NAME,
      serviceType: MONITORING_SERVICE_TYPE,
      projectName: 'monitoring'
    });

    if (!createResult.success || !createResult.service) {
      await prisma.hostService.update({
        where: { serviceName: MONITORING_SERVICE_NAME },
        data: {
          status: 'failed',
          lastError: JSON.stringify({ message: createResult.message, timestamp: new Date().toISOString() })
        }
      });
      return res.status(500).json({ error: createResult.message });
    }

    // Get network/volume requirements from metadata
    const metadata = serviceRegistry.getServiceMetadata(MONITORING_SERVICE_TYPE);
    const networks = metadata?.requiredNetworks || [];
    const volumes = metadata?.requiredVolumes || [];

    // Initialize and start
    await createResult.service.initialize(networks, volumes);
    const startResult = await createResult.service.start();

    if (!startResult.success) {
      await prisma.hostService.update({
        where: { serviceName: MONITORING_SERVICE_NAME },
        data: {
          status: 'failed',
          lastError: JSON.stringify({ message: startResult.message, timestamp: new Date().toISOString() })
        }
      });
      return res.status(500).json({ error: startResult.message });
    }

    // Update DB
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: {
        status: 'running',
        health: 'healthy',
        startedAt: new Date(),
        stoppedAt: null,
        lastError: Prisma.JsonNull
      }
    });

    res.json({
      message: 'Monitoring service started successfully',
      duration: startResult.duration
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start monitoring service');
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: {
        status: 'failed',
        lastError: JSON.stringify({
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        })
      }
    }).catch(() => {});
    res.status(500).json({ error: 'Failed to start monitoring service' });
  }
});

// POST /api/monitoring/stop - Stop the monitoring service
router.post('/stop', requirePermission('monitoring:write'), async (_req, res) => {
  try {
    await getOrCreateDbRecord();

    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: { status: 'stopping' }
    });

    // Stop via factory — this is idempotent and handles missing containers
    await serviceFactory.stopService(MONITORING_SERVICE_NAME);

    // Update DB
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: {
        status: 'stopped',
        health: 'unknown',
        stoppedAt: new Date(),
        lastError: Prisma.JsonNull
      }
    });

    res.json({ message: 'Monitoring service stopped successfully' });
  } catch (error) {
    logger.error({ error }, 'Failed to stop monitoring service');
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: {
        status: 'failed',
        lastError: JSON.stringify({
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        })
      }
    }).catch(() => {});
    res.status(500).json({ error: 'Failed to stop monitoring service' });
  }
});

// POST /api/monitoring/force-remove - Force remove all monitoring containers
router.post('/force-remove', requirePermission('monitoring:write'), async (_req, res) => {
  try {
    await getOrCreateDbRecord();

    // Try to use existing service instance, or create a temporary one
    let service = serviceFactory.getService(MONITORING_SERVICE_NAME) as MonitoringService | undefined;
    if (!service) {
      service = new MonitoringService('monitoring');
      await service.initialize(
        serviceRegistry.getServiceMetadata(MONITORING_SERVICE_TYPE)?.requiredNetworks || [],
        serviceRegistry.getServiceMetadata(MONITORING_SERVICE_TYPE)?.requiredVolumes || []
      );
    }

    const result = await service.forceRemove();

    // Clean up factory entry
    await serviceFactory.stopService(MONITORING_SERVICE_NAME).catch(() => {});

    // Reset DB state
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: {
        status: 'stopped',
        health: 'unknown',
        stoppedAt: new Date(),
        lastError: Prisma.JsonNull
      }
    });

    res.json({
      message: 'Force remove completed',
      removed: result.removed,
      errors: result.errors
    });
  } catch (error) {
    logger.error({ error }, 'Failed to force remove monitoring containers');
    // Still try to reset DB state
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: {
        status: 'stopped',
        health: 'unknown',
        stoppedAt: new Date()
      }
    }).catch(() => {});
    res.status(500).json({ error: 'Failed to force remove monitoring containers' });
  }
});

function isConnectionError(error: unknown): boolean {
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = (error as any).cause;
    return cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET' || cause?.code === 'ENOTFOUND';
  }
  return false;
}

async function handleServiceDown(error: unknown): Promise<void> {
  if (isConnectionError(error)) {
    logger.info('Monitoring service containers are not reachable, marking as stopped');
    await serviceFactory.stopService(MONITORING_SERVICE_NAME).catch(() => {});
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: { status: 'stopped', health: 'unknown', stoppedAt: new Date() }
    }).catch(() => {});
  }
}

// GET /api/monitoring/query - Proxy instant query to Prometheus
router.get('/query', requirePermission('monitoring:read'), async (req, res) => {
  try {
    const { query, time } = req.query;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query parameter is required' });
    }

    const service = await getOrRecoverService();
    if (!service) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }

    const prometheusUrl = service.getPrometheusUrl();
    const params = new URLSearchParams({ query });
    if (time && typeof time === 'string') params.set('time', time);

    const response = await fetch(`${prometheusUrl}/api/v1/query?${params}`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      await handleServiceDown(error);
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

    const service = await getOrRecoverService();
    if (!service) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }

    const prometheusUrl = service.getPrometheusUrl();
    const params = new URLSearchParams({ query, start, end });
    if (step && typeof step === 'string') params.set('step', step);
    else params.set('step', '15s');

    const response = await fetch(`${prometheusUrl}/api/v1/query_range?${params}`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      await handleServiceDown(error);
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Prometheus range');
    res.status(500).json({ error: 'Failed to query Prometheus' });
  }
});

// GET /api/monitoring/targets - Proxy targets query to Prometheus
router.get('/targets', requirePermission('monitoring:read'), async (_req, res) => {
  try {
    const service = await getOrRecoverService();
    if (!service) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }

    const prometheusUrl = service.getPrometheusUrl();
    const response = await fetch(`${prometheusUrl}/api/v1/targets`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      await handleServiceDown(error);
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
    const service = await getOrRecoverService();
    if (!service) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }

    const lokiUrl = service.getLokiUrl();
    const params = new URLSearchParams();
    const { start, end } = req.query;
    if (start && typeof start === 'string') params.set('start', start);
    if (end && typeof end === 'string') params.set('end', end);

    const response = await fetch(`${lokiUrl}/loki/api/v1/labels?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      await handleServiceDown(error);
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Loki labels');
    res.status(500).json({ error: 'Failed to query Loki labels' });
  }
});

// GET /api/monitoring/loki/label/:name/values - List values for a label
router.get('/loki/label/:name/values', requirePermission('monitoring:read'), async (req, res) => {
  try {
    const service = await getOrRecoverService();
    if (!service) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }

    const lokiUrl = service.getLokiUrl();
    const params = new URLSearchParams();
    const { start, end } = req.query;
    if (start && typeof start === 'string') params.set('start', start);
    if (end && typeof end === 'string') params.set('end', end);

    const response = await fetch(`${lokiUrl}/loki/api/v1/label/${encodeURIComponent(req.params.name)}/values?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      await handleServiceDown(error);
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

    const service = await getOrRecoverService();
    if (!service) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }

    const lokiUrl = service.getLokiUrl();
    const params = new URLSearchParams({ query });
    if (start && typeof start === 'string') params.set('start', start);
    if (end && typeof end === 'string') params.set('end', end);
    if (limit && typeof limit === 'string') params.set('limit', limit);
    if (direction && typeof direction === 'string') params.set('direction', direction);

    const response = await fetch(`${lokiUrl}/loki/api/v1/query_range?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      await handleServiceDown(error);
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

    const service = await getOrRecoverService();
    if (!service) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }

    const lokiUrl = service.getLokiUrl();
    const params = new URLSearchParams({ query });
    if (time && typeof time === 'string') params.set('time', time);
    if (limit && typeof limit === 'string') params.set('limit', limit);
    if (direction && typeof direction === 'string') params.set('direction', direction);

    const response = await fetch(`${lokiUrl}/loki/api/v1/query?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    if (isConnectionError(error)) {
      await handleServiceDown(error);
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }
    logger.error({ error }, 'Failed to query Loki');
    res.status(500).json({ error: 'Failed to query Loki' });
  }
});

export default router;
