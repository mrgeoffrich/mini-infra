import { PrismaClient } from '@prisma/client';
import { StackServiceRouting } from '@mini-infra/types';
import { HAProxyFrontendManager } from '../haproxy/haproxy-frontend-manager';
import { HAProxyDataPlaneClient } from '../haproxy';
import { EnvironmentValidationService, HAProxyEnvironmentContext } from '../environment';
import { cloudflareDNSService } from '../cloudflare';
import { networkUtils } from '../network-utils';
import { servicesLogger } from '../../lib/logger-factory';

const logger = servicesLogger();

export interface StackRoutingContext {
  serviceName: string;
  containerId: string;
  containerName: string;
  routing: StackServiceRouting;
  environmentId: string;
  stackId: string;
  stackName: string;
}

export class StackRoutingManager {
  private envValidation = new EnvironmentValidationService();

  constructor(
    private prisma: PrismaClient,
    private haproxyFrontendManager: HAProxyFrontendManager
  ) {}

  async getHAProxyContext(environmentId: string): Promise<HAProxyEnvironmentContext> {
    const ctx = await this.envValidation.getHAProxyEnvironmentContext(environmentId);
    if (!ctx) {
      throw new Error(`HAProxy environment context not available for environment ${environmentId}`);
    }
    return ctx;
  }

  async setupBackendAndServer(
    ctx: StackRoutingContext,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<{ backendName: string; serverName: string }> {
    const backendName = `stk-${ctx.stackName}-${ctx.serviceName}`;
    const serverName = `${ctx.serviceName}-${ctx.containerId.slice(0, 8)}`;

    logger.info({ backendName, serverName, containerName: ctx.containerName }, 'Setting up backend and server');

    // Create backend if not exists
    try {
      await haproxyClient.createBackend({
        name: backendName,
        mode: 'http',
        balance: ctx.routing.backendOptions?.balanceAlgorithm ?? 'roundrobin',
        check_timeout: ctx.routing.backendOptions?.checkTimeout,
        connect_timeout: ctx.routing.backendOptions?.connectTimeout,
        server_timeout: ctx.routing.backendOptions?.serverTimeout,
      });
    } catch (err: any) {
      // Backend may already exist (e.g., on recreate)
      if (!err.message?.includes('already exists') && err.statusCode !== 409) {
        throw err;
      }
      logger.info({ backendName }, 'Backend already exists, reusing');
    }

    // Add server to backend
    await haproxyClient.addServer(backendName, {
      name: serverName,
      address: ctx.containerName,
      port: ctx.routing.listeningPort,
      check: 'enabled',
    });

    // Upsert DB records
    const backendRecord = await this.prisma.hAProxyBackend.upsert({
      where: {
        name_environmentId: {
          name: backendName,
          environmentId: ctx.environmentId,
        },
      },
      update: {
        mode: 'http',
        balanceAlgorithm: ctx.routing.backendOptions?.balanceAlgorithm ?? 'roundrobin',
        checkTimeout: ctx.routing.backendOptions?.checkTimeout ?? null,
        connectTimeout: ctx.routing.backendOptions?.connectTimeout ?? null,
        serverTimeout: ctx.routing.backendOptions?.serverTimeout ?? null,
        status: 'active',
        errorMessage: null,
      },
      create: {
        name: backendName,
        environmentId: ctx.environmentId,
        mode: 'http',
        balanceAlgorithm: ctx.routing.backendOptions?.balanceAlgorithm ?? 'roundrobin',
        checkTimeout: ctx.routing.backendOptions?.checkTimeout ?? null,
        connectTimeout: ctx.routing.backendOptions?.connectTimeout ?? null,
        serverTimeout: ctx.routing.backendOptions?.serverTimeout ?? null,
        sourceType: 'stack',
        status: 'active',
      },
    });

    await this.prisma.hAProxyServer.upsert({
      where: {
        name_backendId: {
          name: serverName,
          backendId: backendRecord.id,
        },
      },
      update: {
        address: ctx.containerName,
        port: ctx.routing.listeningPort,
        check: 'enabled',
        containerId: ctx.containerId,
        containerName: ctx.containerName,
        status: 'active',
        errorMessage: null,
      },
      create: {
        name: serverName,
        backendId: backendRecord.id,
        address: ctx.containerName,
        port: ctx.routing.listeningPort,
        check: 'enabled',
        containerId: ctx.containerId,
        containerName: ctx.containerName,
        status: 'active',
      },
    });

    return { backendName, serverName };
  }

  async configureRoute(
    ctx: StackRoutingContext,
    backendName: string,
    haproxyClient: HAProxyDataPlaneClient,
    sslOptions?: { enableSsl?: boolean; tlsCertificateId?: string }
  ): Promise<void> {
    const enableSsl = sslOptions?.enableSsl ?? false;
    const frontendType = enableSsl ? 'https' : 'http';

    const sharedFrontend = await this.haproxyFrontendManager.getOrCreateSharedFrontend(
      ctx.environmentId,
      frontendType,
      haproxyClient,
      this.prisma
    );

    await this.haproxyFrontendManager.addRouteToSharedFrontend(
      sharedFrontend.id,
      ctx.routing.hostname,
      backendName,
      'stack',
      ctx.stackId,
      haproxyClient,
      this.prisma,
      {
        useSSL: enableSsl,
        tlsCertificateId: sslOptions?.tlsCertificateId,
      }
    );
  }

  async enableTraffic(
    backendName: string,
    serverName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    await haproxyClient.setServerState(backendName, serverName, 'ready');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const stats = await haproxyClient.getServerStats(backendName, serverName);
    if (stats && stats.status !== 'UP') {
      logger.warn({ backendName, serverName, status: stats.status }, 'Server not UP after enabling traffic');
    }
  }

  async drainAndRemoveServer(
    backendName: string,
    serverName: string,
    haproxyClient: HAProxyDataPlaneClient,
    timeoutMs = 30_000
  ): Promise<void> {
    logger.info({ backendName, serverName }, 'Draining server');
    await haproxyClient.setServerState(backendName, serverName, 'drain');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const stats = await haproxyClient.getServerStats(backendName, serverName);
      if (!stats || stats.current_sessions === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    await haproxyClient.deleteServer(backendName, serverName);

    // Delete server record from DB
    const backendRecord = await this.prisma.hAProxyBackend.findFirst({
      where: { name: backendName },
    });
    if (backendRecord) {
      await this.prisma.hAProxyServer.deleteMany({
        where: { backendId: backendRecord.id, name: serverName },
      });
    }
  }

  async removeRoute(
    ctx: StackRoutingContext,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    // Find the route to determine which shared frontend it belongs to
    const route = await this.prisma.hAProxyRoute.findFirst({
      where: { hostname: ctx.routing.hostname },
    });

    if (route) {
      await this.haproxyFrontendManager.removeRouteFromSharedFrontend(
        route.sharedFrontendId,
        ctx.routing.hostname,
        haproxyClient,
        this.prisma
      );
    }

    // Check if backend has remaining servers; if empty, delete backend
    const backendName = `stk-${ctx.stackName}-${ctx.serviceName}`;
    const backendRecord = await this.prisma.hAProxyBackend.findFirst({
      where: { name: backendName, environmentId: ctx.environmentId },
      include: { _count: { select: { servers: true } } },
    });

    if (backendRecord && backendRecord._count.servers === 0) {
      try {
        await haproxyClient.deleteBackend(backendName);
      } catch (err: any) {
        logger.warn({ backendName, error: err.message }, 'Failed to delete empty backend');
      }
      await this.prisma.hAProxyBackend.delete({
        where: { id: backendRecord.id },
      });
    }
  }

  async configureDNS(hostname: string, environmentId: string): Promise<void> {
    // Load environment to check networkType
    const environment = await this.prisma.environment.findUnique({
      where: { id: environmentId },
    });

    if (!environment || environment.networkType !== 'local') {
      return;
    }

    const ip = await networkUtils.getAppropriateIPForEnvironment(environmentId);
    await cloudflareDNSService.upsertARecord(
      hostname,
      ip,
      300,
      false
    );
  }

  async removeDNS(hostname: string): Promise<void> {
    try {
      const zone = await cloudflareDNSService.findZoneForHostname(hostname);
      if (!zone) return;

      const record = await cloudflareDNSService.findDNSRecord(zone.id, hostname);
      if (!record) return;

      await cloudflareDNSService.deleteDNSRecord(zone.id, record.id);
    } catch (err: any) {
      logger.warn({ hostname, error: err.message }, 'DNS removal failed (non-fatal)');
    }
  }
}
