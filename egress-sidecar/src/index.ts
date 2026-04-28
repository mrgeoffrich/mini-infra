/**
 * Entry point — wires together DNS server, admin HTTP server, and signal handling.
 */

import { config } from "./config";
import { logger, getDedupLogger } from "./logging";
import { startDnsServer, stopDnsServer } from "./dns";
import { startAdminServer, stopAdminServer } from "./admin";

const startedAt = new Date().toISOString();

async function main(): Promise<void> {
  logger.info(
    {
      evt: "startup",
      ts: startedAt,
      config: {
        dnsPort: config.dnsPort,
        adminPort: config.adminPort,
        upstreamDns: config.upstreamDns,
        logLevel: config.logLevel,
        dedupWindowMs: config.dedupWindowMs,
        queryTimeoutMs: config.queryTimeoutMs,
      },
    },
    "mini-infra-egress-sidecar starting",
  );

  await startAdminServer();
  await startDnsServer();

  logger.info(
    {
      evt: "startup",
      ts: new Date().toISOString(),
      dnsPort: config.dnsPort,
      adminPort: config.adminPort,
    },
    "egress-sidecar ready",
  );
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ evt: "shutdown", signal }, "Received shutdown signal — shutting down");

  // Flush any pending dedup buckets so log lines aren't lost.
  try {
    getDedupLogger().flush();
  } catch {
    // ignore flush errors on shutdown
  }

  const deadline = setTimeout(() => {
    logger.warn("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 5000);

  if (deadline.unref) deadline.unref();

  try {
    await Promise.all([stopDnsServer(), stopAdminServer()]);
  } catch (err) {
    logger.error({ err }, "Error during shutdown");
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
