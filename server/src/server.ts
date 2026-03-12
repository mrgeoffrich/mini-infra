console.log("[STARTUP] Starting Mini Infra server...");
console.log("[STARTUP] Importing app module...");
import { createServer } from "http";
import app from "./app";
console.log("[STARTUP] ✓ App module imported successfully");
import appConfig from "./lib/config-new";
import { initializeSocketIO, shutdownSocketIO } from "./lib/socket";
import { setupContainerSocketEmitter } from "./services/container-socket-emitter";
import {
  appLogger,
  clearLoggerCache,
  serializeError,
} from "./lib/logger-factory";
import {
  ensureAgentSidecar,
  stopHealthChecks as stopAgentSidecarHealthChecks,
} from "./services/agent-sidecar";

// Clear logger cache on startup to ensure new configuration is loaded
clearLoggerCache();

// Use app logger for server startup
const logger = appLogger();
import DockerService from "./services/docker";
import { ConnectivityScheduler } from "./lib/connectivity-scheduler";
import { BackupSchedulerService } from "./services/backup";
import { RestoreExecutorService } from "./services/restore-executor";
import { setRestoreExecutorService } from "./services/restore-executor/restore-executor-instance";
import { initializeDevApiKey } from "./services/dev-api-key";
import { seedDefaultPresets } from "./services/permission-preset-service";
import { initializeAgentApiKey } from "./services/agent-api-key";
import { getEffectiveApiKey } from "./services/agent-settings-service";
import { AgentProxyService, setAgentService, getAgentService } from "./services/agent-service";
import { PostgresDatabaseHealthScheduler } from "./services/postgres";
import { ServiceRecoveryManager, EnvironmentHealthScheduler } from "./services/environment";
import { ApplicationServiceFactory } from "./services/application-service-factory";
import { SelfBackupScheduler } from "./services/backup";
import serverHealthScheduler from "./services/postgres-server/health-scheduler";
import { UserEventCleanupScheduler } from "./services/user-events";
import prisma from "./lib/prisma";
import { CertificateRenewalScheduler } from "./services/tls/certificate-renewal-scheduler";
import { TlsConfigService } from "./services/tls/tls-config";
import { AzureStorageCertificateStore } from "./services/tls/azure-storage-certificate-store";
import { AcmeClientManager } from "./services/tls/acme-client-manager";
import { DnsChallenge01Provider } from "./services/tls/dns-challenge-provider";
import { CertificateLifecycleManager } from "./services/tls/certificate-lifecycle-manager";
import { CertificateDistributor } from "./services/tls/certificate-distributor";
import { CloudflareService } from "./services/cloudflare";
import { AzureStorageService } from "./services/azure-storage-service";
import { HAProxyService } from "./services/haproxy/haproxy-service";
import { DockerExecutorService } from "./services/docker-executor";
import { securityConfig } from "./lib/security-config";
import { randomBytes } from "crypto";
import { syncBuiltinStacks } from "./services/stacks/builtin-stack-sync";
import { MonitoringService } from "./services/monitoring";
import { cleanupOrphanedSidecars, finalizeLastUpdate } from "./services/self-update";

// Global scheduler instances
let connectivityScheduler: ConnectivityScheduler | null = null;
let backupScheduler: BackupSchedulerService | null = null;
let restoreExecutorService: RestoreExecutorService | null = null;
let postgresDatabaseHealthScheduler: PostgresDatabaseHealthScheduler | null = null;
let environmentHealthScheduler: EnvironmentHealthScheduler | null = null;
let selfBackupScheduler: SelfBackupScheduler | null = null;
let tlsRenewalScheduler: CertificateRenewalScheduler | null = null;
let userEventCleanupScheduler: UserEventCleanupScheduler | null = null;

/**
 * Initialize security secrets from database or generate new ones
 * This must run FIRST before any other service initialization
 */
const initializeSecuritySecrets = async () => {
  console.log("[STARTUP] Initializing security secrets...");

  // Check for ENCRYPTION_SECRET environment variable
  if (!process.env.ENCRYPTION_SECRET) {
    logger.warn(
      "ENCRYPTION_SECRET environment variable is not set. " +
        "PostgreSQL credential encryption will not be available. " +
        "Set ENCRYPTION_SECRET in your .env file to enable secure credential storage."
    );
    console.warn(
      "[STARTUP] ⚠ WARNING: ENCRYPTION_SECRET is not set - PostgreSQL credential encryption is disabled. " +
        "Set this in your .env file."
    );
  } else {
    console.log("[STARTUP] ✓ ENCRYPTION_SECRET is configured");
  }

  try {
    const CATEGORY = "system";
    const SESSION_SECRET_KEY = "session_secret";
    const API_KEY_SECRET_KEY = "api_key_secret";

    // Check if session secret exists
    let sessionSetting = await prisma.systemSettings.findFirst({
      where: {
        category: CATEGORY,
        key: SESSION_SECRET_KEY,
        isActive: true,
      },
    });

    // Generate session secret if it doesn't exist
    if (!sessionSetting || !sessionSetting.value) {
      const newSessionSecret = randomBytes(32).toString("hex");
      console.log("[STARTUP] Session secret not found, generating new one...");

      sessionSetting = await prisma.systemSettings.upsert({
        where: {
          category_key: {
            category: CATEGORY,
            key: SESSION_SECRET_KEY,
          },
        },
        create: {
          category: CATEGORY,
          key: SESSION_SECRET_KEY,
          value: newSessionSecret,
          isEncrypted: false,
          isActive: true,
          createdBy: "system",
          updatedBy: "system",
        },
        update: {
          value: newSessionSecret,
          updatedBy: "system",
          updatedAt: new Date(),
        },
      });

      logger.info("New session secret generated and stored in database");
      console.log("[STARTUP] ✓ New session secret generated");
    } else {
      console.log("[STARTUP] ✓ Session secret loaded from database");
    }

    // Check if API key secret exists
    let apiKeySetting = await prisma.systemSettings.findFirst({
      where: {
        category: CATEGORY,
        key: API_KEY_SECRET_KEY,
        isActive: true,
      },
    });

    // Generate API key secret if it doesn't exist
    if (!apiKeySetting || !apiKeySetting.value) {
      const newApiKeySecret = randomBytes(32).toString("hex");
      console.log("[STARTUP] API key secret not found, generating new one...");

      apiKeySetting = await prisma.systemSettings.upsert({
        where: {
          category_key: {
            category: CATEGORY,
            key: API_KEY_SECRET_KEY,
          },
        },
        create: {
          category: CATEGORY,
          key: API_KEY_SECRET_KEY,
          value: newApiKeySecret,
          isEncrypted: false,
          isActive: true,
          createdBy: "system",
          updatedBy: "system",
        },
        update: {
          value: newApiKeySecret,
          updatedBy: "system",
          updatedAt: new Date(),
        },
      });

      logger.info("New API key secret generated and stored in database");
      console.log("[STARTUP] ✓ New API key secret generated");
    } else {
      console.log("[STARTUP] ✓ API key secret loaded from database");
    }

    // Load secrets into memory
    securityConfig.setSessionSecret(sessionSetting.value);
    securityConfig.setApiKeySecret(apiKeySetting.value);

    logger.info("Security secrets initialized successfully");
    console.log("[STARTUP] ✓ Security secrets initialized and loaded into memory");
  } catch (error) {
    console.error("[STARTUP] FATAL: Failed to initialize security secrets");
    console.error(error);
    throw error;
  }
};

// Initialize Docker connection and connectivity scheduler before starting server
const initializeServices = async () => {
  console.log("[STARTUP] Initializing services...");
  try {
    // Initialize security secrets FIRST (other services depend on these)
    await initializeSecuritySecrets();

    // Initialize Docker service
    console.log("[STARTUP] Initializing Docker service...");
    const dockerService = DockerService.getInstance();
    await dockerService.initialize();
    console.log("[STARTUP] ✓ Docker service initialized");

    // Wire up container state changes to Socket.IO
    setupContainerSocketEmitter();
    console.log("[STARTUP] ✓ Container socket emitter initialized");

    // Clean up orphaned sidecar containers from previous updates
    // and finalize any in-progress update record in the DB
    console.log("[STARTUP] Cleaning up self-update sidecar resources...");
    try {
      await finalizeLastUpdate();
      await cleanupOrphanedSidecars();
      console.log("[STARTUP] ✓ Self-update sidecar cleanup complete");
    } catch (err) {
      logger.warn({ err }, "Self-update sidecar cleanup failed (non-fatal)");
      console.log("[STARTUP] ⚠ Self-update sidecar cleanup failed (non-fatal)");
    }

    // Provision agent sidecar (if running in Docker)
    console.log("[STARTUP] Checking agent sidecar...");
    try {
      const agentSidecarResult = await ensureAgentSidecar();
      if (agentSidecarResult) {
        logger.info(
          {
            containerId: agentSidecarResult.containerId,
            url: agentSidecarResult.url,
          },
          "Agent sidecar provisioned",
        );
        console.log("[STARTUP] ✓ Agent sidecar provisioned");
      } else {
        console.log(
          "[STARTUP] Agent sidecar not started (disabled or not in Docker)",
        );
      }
    } catch (err) {
      logger.warn({ err }, "Agent sidecar provisioning failed (non-fatal)");
      console.log(
        "[STARTUP] ⚠ Agent sidecar provisioning failed (non-fatal)",
      );
    }

    // Initialize connectivity scheduler
    console.log("[STARTUP] Initializing connectivity scheduler...");
    connectivityScheduler = new ConnectivityScheduler(
      prisma,
      appConfig.connectivity.checkInterval,
    );
    connectivityScheduler.start();
    console.log("[STARTUP] ✓ Connectivity scheduler initialized");

    // Initialize backup scheduler
    console.log("[STARTUP] Initializing backup scheduler...");
    backupScheduler = new BackupSchedulerService(prisma);
    BackupSchedulerService.setInstance(backupScheduler);
    await backupScheduler.initialize();
    console.log("[STARTUP] ✓ Backup scheduler initialized");

    // Initialize restore executor service
    console.log("[STARTUP] Initializing restore executor service...");
    restoreExecutorService = new RestoreExecutorService(prisma);
    setRestoreExecutorService(restoreExecutorService);
    await restoreExecutorService.initialize();
    logger.info("RestoreExecutorService initialized successfully");
    console.log("[STARTUP] ✓ Restore executor service initialized");

    // Initialize PostgreSQL database health scheduler
    console.log("[STARTUP] Initializing PostgreSQL database health scheduler...");
    postgresDatabaseHealthScheduler = new PostgresDatabaseHealthScheduler(
      appConfig.connectivity.checkInterval, // Use same interval as connectivity scheduler
    );
    postgresDatabaseHealthScheduler.start();
    logger.info("PostgreSQL database health scheduler initialized successfully");
    console.log("[STARTUP] ✓ PostgreSQL database health scheduler initialized");

    // Configure ApplicationServiceFactory with DockerService for enhanced stop operations
    console.log("[STARTUP] Configuring ApplicationServiceFactory...");
    const serviceFactory = ApplicationServiceFactory.getInstance();
    serviceFactory.setDockerService(dockerService);
    logger.info("ApplicationServiceFactory configured with Docker service");
    console.log("[STARTUP] ✓ ApplicationServiceFactory configured");

    // Perform service recovery to restore running environments after restart
    console.log("[STARTUP] Performing service recovery...");
    const serviceRecoveryManager = new ServiceRecoveryManager(dockerService, serviceFactory);
    await serviceRecoveryManager.performRecovery();
    logger.info("Service recovery completed successfully");
    console.log("[STARTUP] ✓ Service recovery completed");

    // Sync built-in stack definitions
    console.log("[STARTUP] Syncing built-in stack definitions...");
    await syncBuiltinStacks(prisma);
    console.log("[STARTUP] ✓ Built-in stack definitions synced");

    // When running in Docker, connect to monitoring network (if it exists)
    // so the app can proxy requests to Prometheus/Loki by container name
    try {
      const monitoringService = new MonitoringService();
      await monitoringService.initialize();
      await monitoringService.ensureAppConnectedToMonitoringNetwork();
    } catch (err) {
      logger.debug({ error: err }, "Monitoring network connection skipped (non-fatal)");
    }

    // Initialize environment health scheduler (monitors service state every 5 minutes)
    console.log("[STARTUP] Initializing environment health scheduler...");
    environmentHealthScheduler = new EnvironmentHealthScheduler(
      dockerService,
      serviceFactory,
      5 * 60 * 1000 // 5 minutes
    );
    environmentHealthScheduler.start();
    logger.info("Environment health scheduler initialized successfully");
    console.log("[STARTUP] ✓ Environment health scheduler initialized");

    // Initialize self-backup scheduler
    console.log("[STARTUP] Initializing self-backup scheduler...");
    selfBackupScheduler = new SelfBackupScheduler(prisma);
    SelfBackupScheduler.setInstance(selfBackupScheduler);
    await selfBackupScheduler.initialize();
    logger.info("Self-backup scheduler initialized successfully");
    console.log("[STARTUP] ✓ Self-backup scheduler initialized");

    // Initialize user event cleanup scheduler
    console.log("[STARTUP] Initializing user event cleanup scheduler...");
    userEventCleanupScheduler = new UserEventCleanupScheduler(prisma);
    UserEventCleanupScheduler.setInstance(userEventCleanupScheduler);
    await userEventCleanupScheduler.initialize();
    logger.info("User event cleanup scheduler initialized successfully");
    console.log("[STARTUP] ✓ User event cleanup scheduler initialized");

    // Initialize PostgreSQL server health scheduler
    console.log("[STARTUP] Initializing PostgreSQL server health scheduler...");
    serverHealthScheduler.startAll();
    logger.info("PostgreSQL server health scheduler initialized successfully");
    console.log("[STARTUP] ✓ PostgreSQL server health scheduler initialized");

    // Initialize TLS renewal scheduler (if TLS is configured)
    console.log("[STARTUP] Checking TLS configuration...");
    try {
      const tlsConfig = new TlsConfigService(prisma);
      const containerName = await tlsConfig.get("certificate_blob_container");

      if (containerName) {
        console.log("[STARTUP] TLS configuration detected, initializing renewal scheduler...");
        logger.info("TLS configuration detected, initializing renewal scheduler");

        // Get Azure Storage connection string
        const azureConfig = new AzureStorageService(prisma);
        const connectionString = await azureConfig.getConnectionString();

        if (!connectionString) {
          throw new Error("Azure Storage connection not configured. Please configure Azure Storage first.");
        }

        // Initialize TLS services
        const certificateStore = new AzureStorageCertificateStore(connectionString, containerName);
        const acmeClient = new AcmeClientManager(tlsConfig, certificateStore);
        const cloudflareConfig = new CloudflareService(prisma);
        const dnsChallenge = new DnsChallenge01Provider(cloudflareConfig);

        // Initialize ACME client
        await acmeClient.initialize();

        // Create certificate distributor for HAProxy deployment
        const haproxyService = new HAProxyService();
        const dockerExecutor = new DockerExecutorService();
        await dockerExecutor.initialize();
        const distributor = new CertificateDistributor(certificateStore, haproxyService, dockerExecutor);

        // Create lifecycle manager
        const lifecycleManager = new CertificateLifecycleManager(
          acmeClient,
          certificateStore,
          dnsChallenge,
          prisma,
          containerName,
          distributor
        );

        // Create renewal scheduler
        tlsRenewalScheduler = new CertificateRenewalScheduler(lifecycleManager, prisma);

        // Get cron schedule from settings (default: daily at 2 AM)
        const cronSchedule = (await tlsConfig.get("renewal_check_cron")) || "0 2 * * *";
        await tlsRenewalScheduler.start(cronSchedule);

        logger.info({ cronSchedule }, "TLS renewal scheduler initialized successfully");
        console.log("[STARTUP] ✓ TLS renewal scheduler initialized");
      } else {
        logger.info("TLS not configured, skipping renewal scheduler initialization");
        console.log("[STARTUP] TLS not configured, skipping renewal scheduler");
      }
    } catch (error) {
      logger.warn({ error }, "Failed to initialize TLS renewal scheduler (non-fatal)");
      console.log("[STARTUP] ⚠ TLS renewal scheduler initialization failed (non-fatal)");
    }

    // Seed default permission presets if not already present
    console.log("[STARTUP] Seeding default permission presets...");
    await seedDefaultPresets();
    console.log("[STARTUP] ✓ Permission presets seeded");

    // Initialize development API key (development mode only)
    console.log("[STARTUP] Initializing development API key...");
    const devApiKeyResult = await initializeDevApiKey();
    console.log("[STARTUP] ✓ Development API key initialized");
    if (devApiKeyResult) {
      if (devApiKeyResult.isNewKey) {
        logger.info(
          {
            userId: devApiKeyResult.userId,
            keyId: devApiKeyResult.keyId,
          },
          "🔑 Development API key created for Claude",
        );
        logger.info(
          { apiKey: devApiKeyResult.apiKey },
          "🔑 Claude API Key (see structured field)",
        );
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

    // Initialize AI agent service (requires ANTHROPIC_API_KEY from env or DB)
    let anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      // Check database for a previously configured API key
      const dbKey = await getEffectiveApiKey();
      if (dbKey) {
        process.env.ANTHROPIC_API_KEY = dbKey;
        anthropicKey = dbKey;
        logger.info("Loaded ANTHROPIC_API_KEY from database settings");
        console.log("[STARTUP] Loaded ANTHROPIC_API_KEY from database settings");
      }
    }

    if (anthropicKey) {
      console.log("[STARTUP] Initializing agent proxy service...");
      const agentApiKey = await initializeAgentApiKey();
      if (agentApiKey) {
        const agentService = new AgentProxyService();
        setAgentService(agentService);
        logger.info("Agent proxy service initialized (execution via sidecar)");
        console.log("[STARTUP] ✓ Agent proxy service initialized (execution via sidecar)");
      } else {
        logger.warn("Agent API key initialization failed, agent features disabled");
        console.log("[STARTUP] ⚠ Agent API key initialization failed");
      }
    } else {
      logger.info("ANTHROPIC_API_KEY not set, agent features disabled");
      console.log("[STARTUP] Agent features disabled (no ANTHROPIC_API_KEY — configure via Settings)");
    }

    logger.info("All services initialized successfully");
    console.log("[STARTUP] ✓ All services initialized successfully");
  } catch (error) {
    // Use console.error to avoid Pino flush timeout on exit
    console.error("[STARTUP] FATAL: Failed to initialize services - shutting down");
    console.error(error);
    process.exit(1);
  }
};

// Start server after successful service initialization
const startServer = async () => {
  console.log("[STARTUP] Starting server initialization...");
  await initializeServices();
  console.log("[STARTUP] Services initialized, binding to port...");

  console.log(`[STARTUP] Attempting to listen on port ${appConfig.server.port}...`);

  // Create HTTP server and attach Socket.IO before listening
  const httpServer = createServer(app);
  console.log("[STARTUP] Initializing Socket.IO...");
  initializeSocketIO(httpServer);
  console.log("[STARTUP] ✓ Socket.IO initialized");

  const server = httpServer.listen(appConfig.server.port, () => {
    console.log(`[STARTUP] ✓ Server successfully listening on port ${appConfig.server.port}`);
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
      console.log(`[STARTUP] Health check available at: http://localhost:${appConfig.server.port}/health`);
    }
    console.log("[STARTUP] ✓ Server startup completed successfully - ready to accept connections");
  });

  // Handle server errors (e.g., port already in use)
  server.on('error', (error: any) => {
    // Use console.error to avoid Pino flush timeout on exit
    console.error(`[STARTUP] FATAL: Failed to start server on port ${appConfig.server.port}`);
    console.error(error);
    process.exit(1);
  });

  console.log("[STARTUP] Server object created, waiting for listen callback...");
  return server;
};

// Start the application
console.log("[STARTUP] Executing startServer()...");
startServer()
  .then((server) => {
    console.log("[STARTUP] ✓ startServer() completed successfully, server is running");
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

      if (userEventCleanupScheduler) {
        await userEventCleanupScheduler.shutdown();
        logger.info("User event cleanup scheduler stopped");
      }

      // Stop PostgreSQL server health scheduler
      serverHealthScheduler.stopAll();
      logger.info("PostgreSQL server health scheduler stopped");

      // Stop TLS renewal scheduler
      if (tlsRenewalScheduler) {
        tlsRenewalScheduler.stop();
        logger.info("TLS renewal scheduler stopped");
      }

      // Shutdown agent service
      const agentService = getAgentService();
      if (agentService) {
        await agentService.shutdown();
        logger.info("Agent service stopped");
      }

      // Stop agent sidecar health checks (container has its own restart policy)
      stopAgentSidecarHealthChecks();
      logger.info("Agent sidecar health checks stopped");

      // Shut down Socket.IO before closing the HTTP server
      await shutdownSocketIO();
      logger.info("Socket.IO shut down");

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
    console.error("[STARTUP] FATAL: Failed to start server");
    console.error(error);
    process.exit(1);
  });

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  // Use console.error to avoid Pino flush timeout on exit
  console.error("[STARTUP] FATAL: Uncaught Exception - Server shutting down");
  console.error(err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  // Use console.error to avoid Pino flush timeout on exit
  console.error("[STARTUP] FATAL: Unhandled Promise Rejection - Server shutting down");
  console.error("Reason:", reason);
  console.error("Promise:", promise);
  process.exit(1);
});
