console.log("[STARTUP] Starting Mini Infra server...");
// Load logging configuration before any service module is imported, so any
// component logger constructed during transitive imports uses the configured
// level instead of the in-code fallback.
import { loadLoggingConfig } from "./lib/logging-config";
loadLoggingConfig();
// Harden outbound connections (Happy Eyeballs attempt-timeout + IPv4-first)
// BEFORE any service module (which may make outbound fetches) is imported.
// Node's 250ms default abandons healthy cross-region connects (e.g. to
// api.tailscale.com), making `fetch` fail where curl succeeds. See net-runtime.
import { configureOutboundNetworking } from "./lib/net-runtime";
const outboundNet = configureOutboundNetworking();
console.log(
  `[STARTUP] Outbound networking: dnsResultOrder=${outboundNet.dnsResultOrder} autoSelectFamily=${outboundNet.autoSelectFamily} attemptTimeoutMs=${outboundNet.autoSelectFamilyAttemptTimeoutMs}`,
);
console.log("[STARTUP] Importing app module...");
import { createServer } from "http";
import v8 from "v8";
import os from "os";
import path from "path";
import app from "./app";
console.log("[STARTUP] ✓ App module imported successfully");
import appConfig from "./lib/config-new";
import { initializeSocketIO, shutdownSocketIO } from "./lib/socket";
import { setupContainerSocketEmitter } from "./services/container-socket-emitter";
import { getLogger, clearLoggerCache } from "./lib/logger-factory";
import {
  ensureAgentSidecar,
  removeAgentSidecar,
} from "./services/agent-sidecar";

// Clear logger cache on startup to ensure new configuration is loaded
clearLoggerCache();

// Use app logger for server startup
const logger = getLogger("platform", "server");
import DockerService from "./services/docker";
import { ConnectivityScheduler } from "./lib/connectivity-scheduler";
import {
  installPgBackupRuntimeEnvResolver,
  refreshAllPgBackupTriggers,
} from "./services/backup";
import { installRestoreRuntimeEnvResolver } from "./services/restore-executor";
import { initializeDevApiKey } from "./services/dev-api-key";
import { seedDefaultPresets } from "./services/permission-preset-service";
import { initializeAgentApiKey, getAgentApiKey } from "./services/agent-api-key";
import { getEffectiveApiKey } from "./services/agent-settings-service";
import { AgentProxyService, setAgentService, getAgentService } from "./services/agent-service";
import { PostgresDatabaseHealthScheduler } from "./services/postgres";
import { ApplicationServiceFactory } from "./services/application-service-factory";
import { SelfBackupScheduler } from "./services/backup";
import serverHealthScheduler from "./services/postgres-server/health-scheduler";
import { UserEventCleanupScheduler } from "./services/user-events";
import prisma from "./lib/prisma";
import { DnsCacheService, DnsCacheScheduler } from "./services/dns";
import {
  TailscaleDeviceStatusScheduler,
  ensureTailscaleDeviceStatusScheduler,
} from "./services/tailscale";
import { CertificateRenewalScheduler } from "./services/tls/certificate-renewal-scheduler";
import { PoolInstanceReaper } from "./services/stacks/pool-instance-reaper";
import { StackStatusMonitor } from "./services/stacks/stack-status-monitor";
import {
  NetworkGcScheduler,
  NetworkConvergenceScheduler,
  createNetworkManager,
  convergeAll,
  backfillNetworkMemberships,
} from "./services/networks";
import { JobPoolExitWatcher } from "./services/stacks/job-pool-exit-watcher";
import { JobPoolCronRegistry } from "./services/stacks/job-pool-cron-registry";
import { JobPoolNatsRegistry } from "./services/stacks/job-pool-nats-registry";
import { TlsConfigService } from "./services/tls/tls-config";
import { StorageCertificateStore } from "./services/tls/storage-certificate-store";
import { AcmeClientManager } from "./services/tls/acme-client-manager";
import { DnsChallenge01Provider } from "./services/tls/dns-challenge-provider";
import { CertificateLifecycleManager } from "./services/tls/certificate-lifecycle-manager";
import { CertificateDistributor } from "./services/tls/certificate-distributor";
import { CloudflareService } from "./services/cloudflare";
import { StorageService } from "./services/storage/storage-service";
import { HAProxyService } from "./services/haproxy/haproxy-service";
import { DockerExecutorService } from "./services/docker-executor";
import { loadOrCreateInternalAuthSecret } from "./lib/security-config";
import { syncBuiltinStacks } from "./services/stacks/builtin-stack-sync";
import { auditLegacyNatsTemplateData } from "./services/nats/legacy-nats-template-audit";
import { backfillHealthcheckUnits } from "./services/stacks/healthcheck-unit-backfill";
import { runBuiltinVaultReconcile, BUNDLES_DRIVE_BUILTIN } from "./services/stacks/builtin-vault-reconcile";
import { MonitoringService } from "./services/monitoring";
import { cleanupOrphanedSidecars, finalizeLastUpdate } from "./services/self-update";
import { setupHAProxyCrashLoopWatcher } from "./services/haproxy/haproxy-crash-loop-watcher";
import { initVaultServices } from "./services/vault/vault-services";
import { seedVaultPolicies } from "./services/vault/vault-seed";
import { getNatsControlPlaneService } from "./services/nats/nats-control-plane-service";
import { NatsBus } from "./services/nats/nats-bus";
import { registerPingResponder } from "./services/nats/nats-bus-ping";
import { seedSystemNatsResources } from "./services/nats/system-nats-bootstrap";
import {
  startEgressBackgroundServices,
  bootstrapFwAgentStack,
  type ShutdownFn as EgressShutdownFn,
  startFwAgentHealthWatcher,
  stopFwAgentHealthWatcher,
  startEgressSelfHealSupervisor,
  stopEgressSelfHealSupervisor,
  registerEgressCredRefreshHook,
  unregisterEgressCredRefreshHook,
} from "./services/egress";

// Global scheduler instances
let egressShutdown: EgressShutdownFn | null = null;
let connectivityScheduler: ConnectivityScheduler | null = null;
// Phase 4 (MINI-53): BackupSchedulerService retired. Cron handling lives in
// `JobPoolCronRegistry`; per-database schedules flow from
// `BackupConfiguration` rows into the pg-az-backup template's `triggers[]`
// via `refreshAllPgBackupTriggers()`.
// Phase 5 (MINI-54): RestoreExecutorService retired. Manual restore triggers
// land via `POST /api/postgres/restore/:databaseId` → the JobPool spawner →
// `restore-executor` system stack template. The runtime env resolver is
// installed once at boot below (alongside the pg-az-backup resolver).
let postgresDatabaseHealthScheduler: PostgresDatabaseHealthScheduler | null = null;
let selfBackupScheduler: SelfBackupScheduler | null = null;
let tlsRenewalScheduler: CertificateRenewalScheduler | null = null;
let userEventCleanupScheduler: UserEventCleanupScheduler | null = null;
let dnsCacheScheduler: DnsCacheScheduler | null = null;
// Tailscale device-status scheduler is owned by the singleton on
// `TailscaleDeviceStatusScheduler` — see `ensureTailscaleDeviceStatusScheduler`
// which both startup and the settings route call to keep it aligned with the
// current credentials. Read via `TailscaleDeviceStatusScheduler.getInstance()`.
let poolInstanceReaper: PoolInstanceReaper | null = null;
let stackStatusMonitor: StackStatusMonitor | null = null;
let networkGcScheduler: NetworkGcScheduler | null = null;
let networkConvergenceScheduler: NetworkConvergenceScheduler | null = null;
let jobPoolExitWatcher: JobPoolExitWatcher | null = null;
let jobPoolCronRegistry: JobPoolCronRegistry | null = null;
let jobPoolNatsRegistry: JobPoolNatsRegistry | null = null;

/**
 * Initialize the internal auth secret from the database, generating one if
 * missing. Used for JWT signing and API key HMAC hashing. The secret is
 * never exposed via any API, env var, or UI.
 *
 * Must run FIRST before any other service initialization.
 */
const initializeSecuritySecrets = async () => {
  console.log("[STARTUP] Initializing internal auth secret...");
  try {
    await loadOrCreateInternalAuthSecret(prisma);
    console.log("[STARTUP] ✓ Internal auth secret ready");
  } catch (error) {
    console.error("[STARTUP] FATAL: Failed to initialize internal auth secret");
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

    // Migrate PUBLIC_URL env var to database setting (one-time)
    const envPublicUrl = process.env.PUBLIC_URL;
    if (envPublicUrl) {
      const existing = await prisma.systemSettings.findFirst({
        where: { category: "system", key: "public_url", isActive: true },
      });
      if (!existing) {
        await prisma.systemSettings.create({
          data: {
            category: "system",
            key: "public_url",
            value: envPublicUrl,
            isEncrypted: false,
            isActive: true,
            createdBy: "system",
            updatedBy: "system",
          },
        });
        console.log(`[STARTUP] Migrated PUBLIC_URL env var to database setting: ${envPublicUrl}`);
        console.log("[STARTUP] WARNING: PUBLIC_URL env var is deprecated. Remove it from your environment.");
      }
    }

    // Initialize Docker service
    console.log("[STARTUP] Initializing Docker service...");
    const dockerService = DockerService.getInstance();
    await dockerService.initialize();
    console.log("[STARTUP] ✓ Docker service initialized");

    // Network overhaul Phase 6 — one-shot backfill of ManagedNetwork/
    // NetworkMembership rows from InfraResource + current stack definitions,
    // for infrastructure that predates the Phase 6 producers. Idempotent and
    // safe to re-run on every boot (find-or-create throughout — see
    // services/networks/membership-backfill.ts); best-effort, never blocks
    // boot. Also re-triggerable on demand via
    // `POST /api/docker/networks/backfill-memberships`. Runs BEFORE the boot
    // convergence below so a first-boot-after-upgrade sees a maximally
    // complete set of desired-state rows to converge against.
    const runBackfill = async () => {
      try {
        const exec = new DockerExecutorService();
        await exec.initialize();
        await backfillNetworkMemberships(exec, prisma, logger);
      } catch (err) {
        logger.warn({ err }, "Network membership backfill failed (non-fatal)");
      }
    };
    await runBackfill();

    // P3 3.3 — normalise stored healthcheck durations to milliseconds, the
    // canonical unit now declared on StackContainerConfig. Writers used to
    // disagree (authoring UIs stored ms, built-in templates stored seconds)
    // while every container-create path multiplied by 1e9 as though it were all
    // seconds, so UI-authored healthchecks got ~8.3h intervals and never ran.
    // Idempotent via a magnitude heuristic, so it is safe on every boot; runs
    // BEFORE the built-in template sync below re-seeds the system templates.
    try {
      await backfillHealthcheckUnits(prisma, logger);
    } catch (err) {
      logger.warn({ err }, "Healthcheck unit backfill failed (non-fatal)");
    }

    // Network overhaul Phase 8 — general boot convergence. Replaces the old
    // self-network-reattach.ts boot workaround (which only ever re-derived
    // the mini-infra server's OWN attachments from `InfraResource` +
    // `joinSelf`): `convergeAll()` diffs and connects EVERY managed
    // network's missing memberships across every stack, environment, and
    // host scope — the server's own `containerName: 'self'` rows on
    // vault/nats/dataplane/database/egress are just one case of the general
    // "reality drifted from desired state" problem this now handles. A
    // container recreate (e.g. `docker compose up -d`) wipes attachments
    // and the already-synced host stacks don't re-apply on boot, so this
    // is what restores them. Connect-only — never disconnects anything
    // (enforceMemberships defaults to false on every network) — so this is
    // safe to run unconditionally on every boot. Best-effort, never blocks
    // boot. Runs inline now (Docker connected at boot on a configured host)
    // and again from the onConnect callback below (covers the degraded
    // worktree case where Docker connects only after the seeder posts the
    // host — reuses the same onConnect hook the old workaround relied on).
    const runBootConvergence = async () => {
      try {
        const exec = new DockerExecutorService();
        await exec.initialize();
        const networkManager = createNetworkManager(exec);
        const result = await convergeAll({ prisma, networkManager, dockerExecutor: exec, log: logger });
        logger.info(
          {
            networksCreated: result.networksCreated,
            membershipsConnected: result.membershipsConnected,
            membershipsDisconnected: result.membershipsDisconnected,
          },
          "Boot network convergence complete — restored attachment count logged above",
        );
      } catch (err) {
        logger.warn({ err }, "Boot network convergence failed (non-fatal)");
      }
    };
    await runBootConvergence();

    // Re-provision sidecars after Docker reconnects. On a fresh-boot worktree
    // the DB has no docker host yet, so initialize() lands in degraded mode
    // and the inline ensureXxx calls below fail. Once the seeder posts the
    // docker host and DockerConfigService.set triggers refreshConnection(),
    // this callback fires and the sidecars come up without manual restart.
    // Both ensureXxx are idempotent — safe if they already succeeded inline.
    dockerService.onConnect(async () => {
      logger.info("Docker connected, re-provisioning sidecars");
      // Re-run the backfill + boot convergence first so Vault/NATS are
      // reachable for the fw-agent bootstrap (and everything else) below —
      // the inline calls above may have run in a degraded state (Docker not
      // yet connected at that point on a fresh-boot worktree), so both are
      // safe/idempotent to repeat here now that Docker is actually up.
      await runBackfill();
      await runBootConvergence();
      try {
        // ALT-27: fw-agent is now a host-scope stack. The bootstrap is
        // idempotent — if the stack is already applied this is a couple
        // of cheap DB lookups; if it isn't (e.g. Docker just came back
        // and the apply was retrying in the background), this re-arms
        // the apply. Same role the legacy `ensureFwAgent` had here.
        await bootstrapFwAgentStack(prisma);
      } catch (err) {
        logger.warn(
          { err },
          "Egress fw-agent re-provisioning after Docker reconnect failed (non-fatal)",
        );
      }
      try {
        await ensureAgentSidecar({ checkAutoStart: true });
      } catch (err) {
        logger.warn(
          { err },
          "Agent sidecar re-provisioning after Docker reconnect failed (non-fatal)",
        );
      }
    });

    // Wire up container state changes to Socket.IO
    setupContainerSocketEmitter();
    console.log("[STARTUP] ✓ Container socket emitter initialized");

    // Wire up HAProxy crash loop detection and auto-repair
    setupHAProxyCrashLoopWatcher();
    console.log("[STARTUP] ✓ HAProxy crash loop watcher initialized");

    // ALT-27: the fw-agent stack bootstrap runs *after* `syncBuiltinStacks`
    // because the bootstrap needs the `egress-fw-agent` system template to
    // already be upserted in the DB. Originally placed here (mirroring the
    // legacy `ensureFwAgent` slot) but the early bail with reason
    // "template not synced" made the EnvFirewallManager.start() that
    // follows useless on a fresh boot. Moved further down the chain.

    // Start egress firewall background services (non-fatal if they fail)
    console.log("[STARTUP] Starting egress background services...");
    try {
      egressShutdown = await startEgressBackgroundServices(prisma);
      console.log("[STARTUP] ✓ Egress background services started");
    } catch (err) {
      logger.warn({ err }, "Egress background services failed to start (non-fatal)");
      console.log("[STARTUP] ⚠ Egress background services failed to start (non-fatal)");
    }

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

    // Load Anthropic API key from database before provisioning the sidecar.
    const anthropicKey = await getEffectiveApiKey();
    if (anthropicKey) {
      const { setApiKeyConfigured } = await import("./services/agent-service");
      setApiKeyConfigured(true);
      logger.info("Loaded Anthropic API key from database settings");
      console.log("[STARTUP] Loaded Anthropic API key from database settings");
    }

    // Initialize agent API key before provisioning the sidecar so
    // MINI_INFRA_API_KEY is available when the container is created.
    // Runs regardless of Anthropic key — the sidecar still launches and
    // needs to authenticate against /api/routes even before the user
    // configures their Anthropic key.
    await initializeAgentApiKey();

    // Provision agent sidecar (if running in Docker and autoStart is enabled)
    console.log("[STARTUP] Checking agent sidecar...");
    try {
      const agentSidecarResult = await ensureAgentSidecar({ checkAutoStart: true });
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

    // Initialize pool instance reaper (stops idle pool instances on a 60s
    // cadence; also force-fails spawns stuck in `starting` for >5 min and
    // kills JobPool runs that exceed `killAfterSeconds`).
    console.log("[STARTUP] Initializing pool instance reaper...");
    poolInstanceReaper = new PoolInstanceReaper(prisma);
    poolInstanceReaper.start();
    console.log("[STARTUP] ✓ Pool instance reaper initialized");

    // P3 3.1/3.2 — background stack-status monitor. Docker `die`/`destroy`
    // events flip a `synced` stack whose service crashed to `drifted` (the badge
    // used to say everything was fine while the app was down), and a periodic
    // sweep catches out-of-band drift that previously only surfaced when a human
    // opened the plan view. The sweep also backstops the Docker event stream,
    // which has no end/close recovery and can go silently deaf.
    console.log("[STARTUP] Initializing stack status monitor...");
    stackStatusMonitor = new StackStatusMonitor(
      prisma,
      DockerService.getInstance(),
      getLogger("stacks", "stack-status-monitor"),
    );
    stackStatusMonitor.start();
    console.log("[STARTUP] ✓ Stack status monitor initialized");

    // Initialize network GC scheduler (network overhaul Phase 4): a 15-minute
    // dry-run-only sweep for orphaned `mini-infra.managed=true` networks —
    // see NetworkGcScheduler for why it never mutates Docker on its own
    // schedule (POST /api/docker/networks/gc with dryRun:false is the only
    // way to actually remove anything).
    console.log("[STARTUP] Initializing network GC scheduler...");
    networkGcScheduler = new NetworkGcScheduler(prisma, {
      createNetworkManager: async () => {
        const executor = new DockerExecutorService();
        await executor.initialize();
        return createNetworkManager(executor);
      },
    });
    networkGcScheduler.start();
    console.log("[STARTUP] ✓ Network GC scheduler initialized");

    // Initialize network convergence scheduler (network overhaul Phase 8):
    // a periodic full sweep (connect-only unless a network's
    // enforceMemberships is true) plus debounced, scoped convergence
    // triggered by Docker `network` events and container `start` events —
    // see NetworkConvergenceScheduler for the debounce/scoping rationale.
    // Unlike the GC scheduler above, this one DOES mutate Docker on its own
    // schedule: connecting a missing membership is always safe (purely
    // additive), so there is no dry-run gate for that half of its job.
    console.log("[STARTUP] Initializing network convergence scheduler...");
    const buildNetworkConvergenceExecutor = async () => {
      const executor = new DockerExecutorService();
      await executor.initialize();
      return executor;
    };
    networkConvergenceScheduler = new NetworkConvergenceScheduler(prisma, {
      createNetworkManager: async () => createNetworkManager(await buildNetworkConvergenceExecutor()),
      createDockerExecutor: buildNetworkConvergenceExecutor,
    });
    networkConvergenceScheduler.start();
    dockerService.onContainerEvent((event) => networkConvergenceScheduler?.handleContainerEvent(event));
    dockerService.onNetworkEvent((event) => networkConvergenceScheduler?.handleNetworkEvent(event));
    console.log("[STARTUP] ✓ Network convergence scheduler initialized");

    // Initialize JobPool exit watcher (Phase 2 of job-pool-service-type):
    // subscribes to Docker `die` events to finalise JobPool runs, publish
    // history events to JetStream, and schedule retries.
    console.log("[STARTUP] Initializing JobPool exit watcher...");
    const resolveJobPoolDockerExecutor = async () => {
      const { DockerExecutorService } = await import(
        "./services/docker-executor"
      );
      const exec = new DockerExecutorService();
      await exec.initialize();
      return exec;
    };
    jobPoolExitWatcher = new JobPoolExitWatcher(prisma, resolveJobPoolDockerExecutor);
    jobPoolExitWatcher.start();
    console.log("[STARTUP] ✓ JobPool exit watcher initialized");

    // Initialize JobPool trigger registries (Phase 3): cron + nats-request.
    // `loadAll()` rebuilds the live registration set from the DB so a
    // restart re-establishes every declared trigger without an apply.
    console.log("[STARTUP] Initializing JobPool trigger registries...");
    jobPoolCronRegistry = new JobPoolCronRegistry(prisma, resolveJobPoolDockerExecutor);
    JobPoolCronRegistry.setInstance(jobPoolCronRegistry);
    try {
      await jobPoolCronRegistry.loadAll();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "JobPoolCronRegistry.loadAll failed at startup (apply-time refresh will reconcile)",
      );
    }
    jobPoolNatsRegistry = new JobPoolNatsRegistry(prisma, resolveJobPoolDockerExecutor);
    JobPoolNatsRegistry.setInstance(jobPoolNatsRegistry);
    try {
      await jobPoolNatsRegistry.loadAll();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "JobPoolNatsRegistry.loadAll failed at startup (apply-time refresh will reconcile)",
      );
    }
    console.log("[STARTUP] ✓ JobPool trigger registries initialized");

    // Phase 4 (MINI-53): the bespoke BackupSchedulerService is gone. Instead
    // register the per-run runtime env resolver against the pg-az-backup
    // JobPool service (wildcard match — every applied pg-az-backup stack
    // shares one resolver) so `runJobPool()` can mint per-run env at spawn
    // time. The actual cron registrations land via `JobPoolCronRegistry`
    // (already loaded above) — we just need to re-materialise triggers from
    // BackupConfiguration rows in case rows were added while the server was
    // down.
    console.log("[STARTUP] Installing pg-az-backup runtime env resolver and refreshing triggers...");
    installPgBackupRuntimeEnvResolver();
    try {
      await refreshAllPgBackupTriggers(prisma);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "refreshAllPgBackupTriggers failed at startup (next BackupConfiguration mutation will reconcile)",
      );
    }
    console.log("[STARTUP] ✓ pg-az-backup runtime env resolver installed");

    // Phase 5 (MINI-54): restore-executor migrated to a JobPool service.
    // Install the wildcard runtime env resolver that creates the
    // `RestoreOperation` row + mints per-run env on every manual restore
    // trigger. Idempotent; no per-trigger refresh is needed (manual-only,
    // no cron/nats-request triggers to reconcile).
    console.log("[STARTUP] Installing restore-executor runtime env resolver...");
    installRestoreRuntimeEnvResolver();
    logger.info("Restore-executor runtime env resolver installed successfully");
    console.log("[STARTUP] ✓ Restore-executor runtime env resolver installed");

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

    // Sync built-in stack definitions
    console.log("[STARTUP] Syncing built-in stack definitions...");
    const templateByName = await syncBuiltinStacks(prisma);
    console.log("[STARTUP] ✓ Built-in stack definitions synced");

    // Report any template data quarantined by the legacy-NATS drop migration.
    // Silent on the expected install; loud when an operator has a template the
    // product can no longer apply. Diagnostic only — never blocks boot.
    try {
      await auditLegacyNatsTemplateData(prisma);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Legacy NATS template audit failed (non-fatal)",
      );
    }

    // Seed system-owned NATS rows (prefix allowlist entries for the
    // `mini-infra.>` namespace, JetStream streams + consumers shared across
    // env-scoped sidecars). Idempotent. Non-fatal — without these rows the
    // egress-gateway stack apply will fail allowlist validation, but a
    // bootstrap-time failure here shouldn't block the rest of the server.
    try {
      await seedSystemNatsResources(prisma, templateByName);
      console.log("[STARTUP] ✓ System NATS resources seeded");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to seed system NATS resources (non-fatal — will retry on next boot)",
      );
    }

    // ALT-27: bootstrap the egress-fw-agent stack now that the template
    // is in the DB. Phase 2 of split-vault-nats: this only ensures the
    // stack DB row exists — the apply is deferred to whichever caller
    // walks the chain (vault → bootstrap → nats → fw-agent). The
    // egress-fw-agent template's cross-stack `requires` block on the
    // `nats` host stack guarantees a clear PREREQUISITES_NOT_MET if
    // someone fires the apply before NATS is synced.
    console.log("[STARTUP] Bootstrapping egress fw-agent stack...");
    try {
      const result = await bootstrapFwAgentStack(prisma);
      if (result.stackId) {
        logger.info(
          { stackId: result.stackId, reason: result.reason },
          "Egress fw-agent stack bootstrapped (apply deferred)",
        );
        console.log(
          `[STARTUP] ✓ Egress fw-agent stack ${result.stackId.slice(0, 8)} (apply: deferred${result.reason ? " — " + result.reason : ""})`,
        );
      } else {
        console.log(
          `[STARTUP] Egress fw-agent stack not bootstrapped (${result.reason ?? "unknown"})`,
        );
      }
    } catch (err) {
      logger.warn({ err }, "Egress fw-agent stack bootstrap failed (non-fatal)");
      console.log("[STARTUP] ⚠ Egress fw-agent stack bootstrap failed (non-fatal)");
    }

    // Initialize Vault services (always-on; Vault itself is optional)
    console.log("[STARTUP] Initializing Vault services...");
    try {
      const vaultServices = initVaultServices(prisma);
      await vaultServices.passphrase.refresh();
      await vaultServices.passphrase.tryAutoUnlockFromEnv();
      // Seed built-in vault policies (idempotent; rows only).
      await seedVaultPolicies(prisma);
      // Point the admin client at the configured address if one exists.
      const meta = await vaultServices.stateService.getMeta();
      if (meta?.address) {
        vaultServices.admin.useClient(meta.address);
        if (vaultServices.passphrase.isUnlocked() && meta.bootstrappedAt) {
          try {
            await vaultServices.admin.authenticateAsAdmin();
            // Idempotent — refreshes operator/account JWTs and the rendered
            // nats.conf in Vault KV. Safe to skip if no nats stack is
            // installed; the conf will simply sit unread in the KV.
            try {
              await getNatsControlPlaneService().applyConfig();
              // applyConfig() rotates the server-bus creds blob in Vault KV
              // every run. invalidateCreds() forces a reconnect when the bus
              // is already running (subsequent applies). On the cold-boot
              // path the bus hasn't started yet — see invalidateCreds()'s
              // pre-start handling — and the first connect later in the
              // boot sequence reads the fresh creds straight out of Vault.
              NatsBus.getInstance().invalidateCreds();
            } catch (natsErr) {
              logger.warn(
                { err: natsErr instanceof Error ? natsErr.message : String(natsErr) },
                "NATS bootstrap at server boot failed (non-fatal)",
              );
            }
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "Vault admin re-auth at boot failed (non-fatal)",
            );
          }
        }
      }
      // Start the watcher — it is a no-op when Vault isn't configured.
      vaultServices.healthWatcher.start();
      logger.info("Vault services initialized");
      console.log("[STARTUP] ✓ Vault services initialized");
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to initialize Vault services (non-fatal)",
      );
    }

    // Start the system NATS bus. Non-blocking — the connect loop runs in
    // the background and tolerates the nats stack not being up yet (fresh
    // worktree boot, or NATS container restart). Registering the ping
    // responder before `ready()` is important: NatsBus subscriptions are
    // durable across reconnects, so the responder is attached automatically
    // whenever the bus first reaches `connected`.
    try {
      NatsBus.getInstance().start();
      registerPingResponder();
      // ALT-27 Stage D10: start the fw-agent health watcher unconditionally
      // — the watcher tolerates a disconnected bus internally (its
      // pollHealthOnce catch keeps the cached value), so calling it before
      // the bus is ready is safe. Keeping it outside the `ready()` try
      // avoids a slow-NATS cold boot leaving the watcher permanently
      // unstarted (review finding H1).
      startFwAgentHealthWatcher();
      // Phase 4: start the self-heal supervisor right after the health watcher
      // — it consumes the watcher's cached auth-failing signal and force-
      // recreates an egress stack stuck auth-failing (re-minting its creds).
      // It's feature-flagged (default ON), tolerates a disconnected bus (its
      // probe is best-effort), and its first tick is deferred a full interval
      // so the watcher has time to populate a connection state.
      startEgressSelfHealSupervisor(prisma);
      // Phase 6: register the live cred-refresh hook on the NATS control plane.
      // On a NATS identity rotation it re-mints + rewrites each running egress
      // agent's creds file in place (no recreate); the agent recovers on its
      // next reconnect. Fully guarded — a push failure defers to the Phase 4
      // supervisor's recreate. Feature-flagged (egress-fw-agent.live_cred_refresh,
      // default ON).
      registerEgressCredRefreshHook(prisma);
      // Probe whether the bus is up *now* so the operator gets a
      // confidence-building startup banner. The 3s budget is short on
      // purpose — Vault unlock + creds fetch typically takes longer than
      // that on a fresh worktree, and we don't want boot to wait on it.
      try {
        await NatsBus.getInstance().ready({ timeoutMs: 3_000 });
        console.log("[STARTUP] ✓ NATS bus connected");
      } catch (busErr) {
        logger.info(
          { err: busErr instanceof Error ? busErr.message : String(busErr) },
          "NATS bus not connected at boot — will keep retrying in the background",
        );
        console.log("[STARTUP] NATS bus retrying in background (non-fatal)");
      }

      // The dependent fire-and-forget helpers below MUST run regardless of
      // whether the 3s ready-probe above succeeded — both helpers handle a
      // not-yet-ready bus internally (bootstrap waits up to 10s on its own;
      // bus.subscribe / bus.jetstream.consume are durable across reconnects
      // and queue subscriptions when the bus comes up later). Gating them on
      // the probe meant fresh-worktree boots — where NATS reliably takes
      // ~10-15s to come up while Vault unlocks — silently skipped them and
      // the EgressFwEvents stream + backup bridge were never bootstrapped.
      try {
        // ALT-27: ensure JetStream streams + KV buckets system-internal
        // subjects depend on (EgressFwEvents stream, egress-fw-health KV).
        // Fire-and-forget — the helper logs its own errors and the next
        // boot retries.
        const { bootstrapNatsSystemResources } = await import(
          "./services/nats/nats-system-bootstrap"
        );
        void bootstrapNatsSystemResources();
        // ALT-29: start the backup/restore NATS bridge — fans
        // `mini-infra.backup.progress.>` events out as Socket.IO updates,
        // and consumes per-pool JobPool history streams to repair stale
        // BackupOperation / RestoreOperation rows on cold boot. The
        // legacy `BackupHistory` JetStream consumer was retired in Phase 4
        // of the job-pool-service-type migration (the per-pool JobHistory
        // streams now own that observability surface).
        const { startBackupNatsBridge } = await import("./services/backup");
        startBackupNatsBridge(prisma);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "NATS dependent helper start failed (non-fatal)",
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "NATS bus start failed (non-fatal)",
      );
    }

    // Run builtin Vault reconciler after Vault services are ready.
    // Only active when BUNDLES_DRIVE_BUILTIN=true; non-fatal on failure.
    if (BUNDLES_DRIVE_BUILTIN) {
      console.log("[STARTUP] Running builtin vault reconcile (BUNDLES_DRIVE_BUILTIN)...");
      try {
        await runBuiltinVaultReconcile(prisma, templateByName, logger);
        console.log("[STARTUP] ✓ Builtin vault reconcile complete");
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Builtin vault reconcile failed at boot (non-fatal)",
        );
        console.log("[STARTUP] ⚠ Builtin vault reconcile failed (non-fatal)");
      }
    }

    // When running in Docker, connect to monitoring network (if it exists)
    // so the app can proxy requests to Prometheus/Loki by container name
    try {
      const monitoringService = new MonitoringService();
      await monitoringService.initialize();
      await monitoringService.ensureAppConnectedToMonitoringNetwork();
    } catch (err) {
      logger.debug({ error: err }, "Monitoring network connection skipped (non-fatal)");
    }

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

        // Resolve the active storage backend (Azure today; Drive in Phase 3).
        let storageBackend;
        try {
          storageBackend = await StorageService.getInstance(prisma).getActiveBackend();
        } catch (err) {
          throw new Error(
            `No storage provider is configured (${err instanceof Error ? err.message : "unknown"}). Configure a storage provider first.`,
            { cause: err },
          );
        }

        // Initialize TLS services using the provider-agnostic cert store
        const certificateStore = new StorageCertificateStore(storageBackend, containerName);
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

    // Initialize DNS cache scheduler
    try {
      console.log("[STARTUP] Initializing DNS cache scheduler...");
      const dnsCacheService = new DnsCacheService(prisma);
      DnsCacheService.setInstance(dnsCacheService);
      dnsCacheScheduler = new DnsCacheScheduler(dnsCacheService);
      await dnsCacheScheduler.start();
      logger.info("DNS cache scheduler initialized successfully");
      console.log("[STARTUP] ✓ DNS cache scheduler initialized");
    } catch (error) {
      logger.warn({ error }, "Failed to initialize DNS cache scheduler (non-fatal)");
      console.log("[STARTUP] ⚠ DNS cache scheduler initialization failed (non-fatal)");
    }

    // Initialize Tailscale device-status scheduler. The helper is idempotent
    // and re-runnable: on credential save / delete the tailscale-settings
    // route handlers call it again so configuring Tailscale post-boot starts
    // the scheduler without an app restart, and removing credentials stops
    // it.
    console.log("[STARTUP] Reconciling Tailscale device-status scheduler...");
    await ensureTailscaleDeviceStatusScheduler(prisma);
    if (TailscaleDeviceStatusScheduler.getInstance()) {
      console.log("[STARTUP] ✓ Tailscale device-status scheduler initialized");
    } else {
      console.log(
        "[STARTUP] Tailscale not configured, device-status scheduler idle",
      );
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
          "💡 Use 'pnpm --filter mini-infra-server show-dev-key' to display the API key information",
        );
      }
    }

    // Initialize AI agent proxy service (agent API key was initialized earlier)
    if (anthropicKey) {
      console.log("[STARTUP] Initializing agent proxy service...");
      const agentApiKey = getAgentApiKey();
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
      logger.info("Anthropic API key not configured, agent features disabled");
      console.log("[STARTUP] Agent features disabled (no API key — configure via Settings)");
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
  server.on('error', (error: NodeJS.ErrnoException) => {
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
      if (egressShutdown) {
        egressShutdown();
        logger.info("Egress background services stopped");
      }

      if (connectivityScheduler) {
        connectivityScheduler.stop();
        logger.info("Connectivity scheduler stopped");
      }

      if (postgresDatabaseHealthScheduler) {
        postgresDatabaseHealthScheduler.stop();
        logger.info("PostgreSQL database health scheduler stopped");
      }

      // Phase 4 (MINI-53): BackupSchedulerService is gone. The
      // JobPoolCronRegistry's `stopAll()` (already called below via its own
      // shutdown wiring) handles the live cron entries that drive backup
      // runs now.

      // Phase 5 (MINI-54): RestoreExecutorService gone. The JobPool exit
      // watcher (`stopAll()` already called below via its own shutdown
      // wiring) handles the in-flight restore container's lifecycle now.

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

      // Stop DNS cache scheduler
      if (dnsCacheScheduler) {
        dnsCacheScheduler.stop();
        logger.info("DNS cache scheduler stopped");
      }

      // Stop Tailscale device-status scheduler
      const tsScheduler = TailscaleDeviceStatusScheduler.getInstance();
      if (tsScheduler) {
        tsScheduler.stop();
        TailscaleDeviceStatusScheduler.setInstance(null);
        logger.info("Tailscale device-status scheduler stopped");
      }

      // Stop pool instance reaper
      if (poolInstanceReaper) {
        poolInstanceReaper.stop();
        logger.info("Pool instance reaper stopped");
      }

      // Stop stack status monitor
      if (stackStatusMonitor) {
        stackStatusMonitor.stop();
        logger.info("Stack status monitor stopped");
      }

      // Stop network GC scheduler
      if (networkGcScheduler) {
        networkGcScheduler.stop();
        logger.info("Network GC scheduler stopped");
      }

      // Stop network convergence scheduler
      if (networkConvergenceScheduler) {
        networkConvergenceScheduler.stop();
        logger.info("Network convergence scheduler stopped");
      }

      // Stop JobPool trigger registries before tearing down the bus —
      // the NATS registry's cancel handlers go through the bus.
      if (jobPoolCronRegistry) {
        try {
          jobPoolCronRegistry.stopAll();
          logger.info("JobPool cron registry stopped");
        } catch (err) {
          logger.warn({ err }, "JobPool cron registry stop failed (non-fatal)");
        }
        JobPoolCronRegistry.setInstance(null);
      }
      if (jobPoolNatsRegistry) {
        try {
          jobPoolNatsRegistry.stopAll();
          logger.info("JobPool NATS registry stopped");
        } catch (err) {
          logger.warn({ err }, "JobPool NATS registry stop failed (non-fatal)");
        }
        JobPoolNatsRegistry.setInstance(null);
      }

      // Stop the fw-agent health watcher before draining the bus —
      // otherwise its 2s tick races the bus shutdown with a stale KV
      // read.
      try {
        stopFwAgentHealthWatcher();
      } catch (err) {
        logger.warn({ err }, "fw-agent health watcher stop failed (non-fatal)");
      }

      // Stop the self-heal supervisor alongside the health watcher so its
      // tick can't fire a recreate mid-shutdown.
      try {
        stopEgressSelfHealSupervisor();
      } catch (err) {
        logger.warn({ err }, "egress self-heal supervisor stop failed (non-fatal)");
      }

      // Phase 6: clear the live cred-refresh hook so no post-apply push can
      // fire mid-shutdown.
      try {
        unregisterEgressCredRefreshHook();
      } catch (err) {
        logger.warn({ err }, "egress live cred refresh hook unregister failed (non-fatal)");
      }

      // Drain the system NATS bus before stopping containers — otherwise
      // any in-flight publishes (including ping replies) get truncated and
      // log noise spikes during shutdown.
      try {
        await NatsBus.getInstance().shutdown();
        logger.info("NATS bus drained");
      } catch (err) {
        logger.warn({ err }, "NATS bus shutdown failed (non-fatal)");
      }

      // Shutdown agent service
      const agentService = getAgentService();
      if (agentService) {
        await agentService.shutdown();
        logger.info("Agent service stopped");
      }

      // Stop and remove the agent sidecar container (it has no persistent state)
      try {
        await removeAgentSidecar();
        logger.info("Agent sidecar stopped and removed");
      } catch (err) {
        logger.warn({ err }, "Failed to remove agent sidecar during shutdown (non-fatal)");
      }

      // ALT-27: fw-agent is now a stack — its container lifecycle is owned
      // by the stack reconciler. We deliberately leave it running across
      // mini-infra-server restarts: nftables rules and the persisted env
      // store survive container restarts (kernel + shared volume), and
      // the next boot's `bootstrapFwAgentStack` is idempotent (no-op if
      // the container is already in sync). Stopping it here would force a
      // rule-replay on every server restart for no benefit.

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

    // SIGUSR2 triggers a heap snapshot on disk — useful for diagnosing leaks
    // in a running container without restart. Retrieve via `docker cp`.
    process.on("SIGUSR2", () => {
      const dir = process.env.HEAP_SNAPSHOT_DIR || os.tmpdir();
      const filePath = path.join(dir, `heap-${Date.now()}-${process.pid}.heapsnapshot`);
      try {
        const startedAt = Date.now();
        const written = v8.writeHeapSnapshot(filePath);
        logger.info(
          { path: written, durationMs: Date.now() - startedAt },
          "Heap snapshot written (SIGUSR2)",
        );
      } catch (err) {
        logger.error({ err }, "Failed to write heap snapshot on SIGUSR2");
      }
    });
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
