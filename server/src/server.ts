// Initialize OpenTelemetry FIRST - before any other imports
import { initializeTelemetry, shutdownTelemetry } from "./lib/telemetry";
initializeTelemetry();

import app from "./app";
import appConfig from "./lib/config-new";
import {
  appLogger,
  clearLoggerCache,
  serializeError,
} from "./lib/logger-factory";

// Clear logger cache on startup to ensure new configuration is loaded
clearLoggerCache();

// Use app logger for server startup
const logger = appLogger();
import DockerService from "./services/docker";
import { ConnectivityScheduler } from "./lib/connectivity-scheduler";
import { BackupSchedulerService } from "./services/backup-scheduler";
import { RestoreExecutorService } from "./services/restore-executor";
import { setRestoreExecutorService } from "./services/restore-executor-instance";
import { initializeDevApiKey } from "./services/dev-api-key";
import { PostgresDatabaseHealthScheduler } from "./services/postgres-database-health-scheduler";
import { ServiceRecoveryManager } from "./services/service-recovery";
import { EnvironmentHealthScheduler } from "./services/environment-health-scheduler";
import { ApplicationServiceFactory } from "./services/application-service-factory";
import { SelfBackupScheduler } from "./services/self-backup-scheduler";
import serverHealthScheduler from "./services/postgres-server/health-scheduler";
import prisma from "./lib/prisma";
import { CertificateRenewalScheduler } from "./services/tls/certificate-renewal-scheduler";
import { TlsConfigService } from "./services/tls/tls-config";
import { AzureKeyVaultCertificateStore } from "./services/tls/azure-keyvault-certificate-store";
import { AcmeClientManager } from "./services/tls/acme-client-manager";
import { DnsChallenge01Provider } from "./services/tls/dns-challenge-provider";
import { CertificateLifecycleManager } from "./services/tls/certificate-lifecycle-manager";
import { CloudflareConfigService } from "./services/cloudflare-config";
import { DefaultAzureCredential, ClientSecretCredential } from "@azure/identity";

// Global scheduler instances
let connectivityScheduler: ConnectivityScheduler | null = null;
let backupScheduler: BackupSchedulerService | null = null;
let restoreExecutorService: RestoreExecutorService | null = null;
let postgresDatabaseHealthScheduler: PostgresDatabaseHealthScheduler | null = null;
let environmentHealthScheduler: EnvironmentHealthScheduler | null = null;
let selfBackupScheduler: SelfBackupScheduler | null = null;
let tlsRenewalScheduler: CertificateRenewalScheduler | null = null;

// Initialize Docker connection and connectivity scheduler before starting server
const initializeServices = async () => {
  try {
    // Initialize Docker service
    const dockerService = DockerService.getInstance();
    await dockerService.initialize();

    // Initialize connectivity scheduler
    connectivityScheduler = new ConnectivityScheduler(
      prisma,
      appConfig.connectivity.checkInterval,
    );
    connectivityScheduler.start();

    // Initialize backup scheduler
    backupScheduler = new BackupSchedulerService(prisma);
    BackupSchedulerService.setInstance(backupScheduler);
    await backupScheduler.initialize();

    // Initialize restore executor service
    restoreExecutorService = new RestoreExecutorService(prisma);
    setRestoreExecutorService(restoreExecutorService);
    await restoreExecutorService.initialize();
    logger.info("RestoreExecutorService initialized successfully");

    // Initialize PostgreSQL database health scheduler
    postgresDatabaseHealthScheduler = new PostgresDatabaseHealthScheduler(
      appConfig.connectivity.checkInterval, // Use same interval as connectivity scheduler
    );
    postgresDatabaseHealthScheduler.start();
    logger.info("PostgreSQL database health scheduler initialized successfully");

    // Configure ApplicationServiceFactory with DockerService for enhanced stop operations
    const serviceFactory = ApplicationServiceFactory.getInstance();
    serviceFactory.setDockerService(dockerService);
    logger.info("ApplicationServiceFactory configured with Docker service");

    // Perform service recovery to restore running environments after restart
    const serviceRecoveryManager = new ServiceRecoveryManager(dockerService, serviceFactory);
    await serviceRecoveryManager.performRecovery();
    logger.info("Service recovery completed successfully");

    // Initialize environment health scheduler (monitors service state every 5 minutes)
    environmentHealthScheduler = new EnvironmentHealthScheduler(
      dockerService,
      serviceFactory,
      5 * 60 * 1000 // 5 minutes
    );
    environmentHealthScheduler.start();
    logger.info("Environment health scheduler initialized successfully");

    // Initialize self-backup scheduler
    selfBackupScheduler = new SelfBackupScheduler(prisma);
    SelfBackupScheduler.setInstance(selfBackupScheduler);
    await selfBackupScheduler.initialize();
    logger.info("Self-backup scheduler initialized successfully");

    // Initialize PostgreSQL server health scheduler
    serverHealthScheduler.startAll();
    logger.info("PostgreSQL server health scheduler initialized successfully");

    // Initialize TLS renewal scheduler (if TLS is configured)
    try {
      const tlsConfig = new TlsConfigService(prisma);
      const keyVaultUrl = await tlsConfig.get("key_vault_url");

      if (keyVaultUrl) {
        logger.info("TLS configuration detected, initializing renewal scheduler");

        // Get credentials for Key Vault
        const tenantId = await tlsConfig.get("key_vault_tenant_id");
        const clientId = await tlsConfig.get("key_vault_client_id");
        const clientSecret = await tlsConfig.get("key_vault_client_secret");

        let credential;
        if (tenantId && clientId && clientSecret) {
          credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
        } else {
          credential = new DefaultAzureCredential();
        }

        // Initialize TLS services
        const keyVaultStore = new AzureKeyVaultCertificateStore(keyVaultUrl, credential);
        const acmeClient = new AcmeClientManager(tlsConfig, keyVaultStore);
        const cloudflareConfig = new CloudflareConfigService(prisma);
        const dnsChallenge = new DnsChallenge01Provider(cloudflareConfig);

        // Initialize ACME client
        await acmeClient.initialize();

        // Create lifecycle manager
        const lifecycleManager = new CertificateLifecycleManager(
          acmeClient,
          keyVaultStore,
          dnsChallenge,
          prisma
        );

        // Create renewal scheduler
        tlsRenewalScheduler = new CertificateRenewalScheduler(lifecycleManager, prisma);

        // Get cron schedule from settings (default: daily at 2 AM)
        const cronSchedule = (await tlsConfig.get("renewal_check_cron")) || "0 2 * * *";
        await tlsRenewalScheduler.start(cronSchedule);

        logger.info({ cronSchedule }, "TLS renewal scheduler initialized successfully");
      } else {
        logger.info("TLS not configured, skipping renewal scheduler initialization");
      }
    } catch (error) {
      logger.warn({ error }, "Failed to initialize TLS renewal scheduler (non-fatal)");
    }

    // Initialize development API key (development mode only)
    const devApiKeyResult = await initializeDevApiKey();
    if (devApiKeyResult) {
      if (devApiKeyResult.isNewKey) {
        logger.info(
          {
            userId: devApiKeyResult.userId,
            keyId: devApiKeyResult.keyId,
          },
          "🔑 Development API key created for Claude",
        );
        logger.info(`🔑 Claude API Key: ${devApiKeyResult.apiKey}`);
        logger.info(
          "💡 Use this API key in Authorization header: Bearer <key> or x-api-key header",
        );
      } else {
        logger.info(
          {
            userId: devApiKeyResult.userId,
            keyId: devApiKeyResult.keyId,
          },
          "🔑 Development API key already exists for Claude",
        );
        logger.info(
          "💡 Use 'npm run show-dev-key' to display the API key information",
        );
      }
    }

    logger.info("All services initialized successfully");
  } catch (error) {
    // Use console.error to avoid Pino flush timeout on exit
    console.error("FATAL: Failed to initialize services - shutting down");
    console.error(error);
    process.exit(1);
  }
};

// Start server after successful service initialization
const startServer = async () => {
  await initializeServices();

  const server = app.listen(appConfig.server.port, () => {
    logger.info(
      {
        port: appConfig.server.port,
        environment: appConfig.server.nodeEnv,
        logLevel: appConfig.logging.level,
      },
      `🚀 Mini Infra server started on port ${appConfig.server.port}`,
    );

    if (appConfig.server.nodeEnv === "development") {
      logger.info(
        `📊 Health check available at: http://localhost:${appConfig.server.port}/health`,
      );
    }
  });

  // Handle server errors (e.g., port already in use)
  server.on('error', (error: any) => {
    // Use console.error to avoid Pino flush timeout on exit
    console.error(`FATAL: Failed to start server on port ${appConfig.server.port}`);
    console.error(error);
    process.exit(1);
  });

  return server;
};

// Start the application
startServer()
  .then((server) => {
    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, starting graceful shutdown`);

      // Stop schedulers
      if (connectivityScheduler) {
        connectivityScheduler.stop();
        logger.info("Connectivity scheduler stopped");
      }

      if (postgresDatabaseHealthScheduler) {
        postgresDatabaseHealthScheduler.stop();
        logger.info("PostgreSQL database health scheduler stopped");
      }

      if (environmentHealthScheduler) {
        environmentHealthScheduler.stop();
        logger.info("Environment health scheduler stopped");
      }

      if (backupScheduler) {
        await backupScheduler.shutdown();
        logger.info("Backup scheduler stopped");
      }

      if (restoreExecutorService) {
        await restoreExecutorService.shutdown();
        logger.info("Restore executor service stopped");
      }

      if (selfBackupScheduler) {
        await selfBackupScheduler.shutdown();
        logger.info("Self-backup scheduler stopped");
      }

      // Stop PostgreSQL server health scheduler
      serverHealthScheduler.stopAll();
      logger.info("PostgreSQL server health scheduler stopped");

      // Stop TLS renewal scheduler
      if (tlsRenewalScheduler) {
        tlsRenewalScheduler.stop();
        logger.info("TLS renewal scheduler stopped");
      }

      // Shutdown OpenTelemetry
      await shutdownTelemetry();

      server.close((err) => {
        if (err) {
          logger.error({ error: err }, "Error during server shutdown");
          process.exit(1);
        }

        logger.info("Server closed successfully");
        process.exit(0);
      });

      // Force shutdown after 30 seconds
      setTimeout(() => {
        logger.error("Forced shutdown after 30 seconds");
        process.exit(1);
      }, 30000);
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  })
  .catch((error) => {
    // Use console.error to avoid Pino flush timeout on exit
    console.error("FATAL: Failed to start server");
    console.error(error);
    process.exit(1);
  });

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  // Use console.error to avoid Pino flush timeout on exit
  console.error("FATAL: Uncaught Exception - Server shutting down");
  console.error(err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  // Use console.error to avoid Pino flush timeout on exit
  console.error("FATAL: Unhandled Promise Rejection - Server shutting down");
  console.error("Reason:", reason);
  console.error("Promise:", promise);
  process.exit(1);
});
