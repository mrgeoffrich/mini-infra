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

    // Try to get live status from running service
    const service = serviceFactory.getService(MONITORING_SERVICE_NAME);
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

    if (dbRecord.status === 'running') {
      return res.status(400).json({ error: 'Monitoring service is already running' });
    }

    // Update DB status to starting
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: { status: 'starting' }
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
    const dbRecord = await getOrCreateDbRecord();

    if (dbRecord.status === 'stopped') {
      return res.status(400).json({ error: 'Monitoring service is already stopped' });
    }

    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: { status: 'stopping' }
    });

    // Stop via factory
    await serviceFactory.stopService(MONITORING_SERVICE_NAME);

    // Update DB
    await prisma.hostService.update({
      where: { serviceName: MONITORING_SERVICE_NAME },
      data: {
        status: 'stopped',
        health: 'unknown',
        stoppedAt: new Date()
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

// GET /api/monitoring/query - Proxy instant query to Prometheus
router.get('/query', requirePermission('monitoring:read'), async (req, res) => {
  try {
    const { query, time } = req.query;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query parameter is required' });
    }

    const service = serviceFactory.getService(MONITORING_SERVICE_NAME) as MonitoringService | undefined;
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

    const service = serviceFactory.getService(MONITORING_SERVICE_NAME) as MonitoringService | undefined;
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
    logger.error({ error }, 'Failed to query Prometheus range');
    res.status(500).json({ error: 'Failed to query Prometheus' });
  }
});

// GET /api/monitoring/targets - Proxy targets query to Prometheus
router.get('/targets', requirePermission('monitoring:read'), async (_req, res) => {
  try {
    const service = serviceFactory.getService(MONITORING_SERVICE_NAME) as MonitoringService | undefined;
    if (!service) {
      return res.status(503).json({ error: 'Monitoring service is not running' });
    }

    const prometheusUrl = service.getPrometheusUrl();
    const response = await fetch(`${prometheusUrl}/api/v1/targets`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    logger.error({ error }, 'Failed to query Prometheus targets');
    res.status(500).json({ error: 'Failed to query Prometheus targets' });
  }
});

export default router;
