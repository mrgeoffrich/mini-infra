import http from "http";
import { logger } from "./logger";

export interface HealthCheckOptions {
  url: string;
  timeoutMs: number;
  intervalMs?: number;
}

/**
 * Polls a health endpoint until it returns a 2xx status or the timeout expires.
 * Uses only the Node.js built-in http module — no external dependencies.
 */
export async function waitForHealthy(
  options: HealthCheckOptions,
): Promise<boolean> {
  const { url, timeoutMs, intervalMs = 3000 } = options;
  const deadline = Date.now() + timeoutMs;

  logger.info({ url, timeoutMs }, "Starting health check polling");

  while (Date.now() < deadline) {
    try {
      const healthy = await probe(url);
      if (healthy) {
        logger.info("Health check passed");
        return true;
      }
    } catch {
      // Expected while container is starting up
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  logger.error({ url, timeoutMs }, "Health check timed out");
  return false;
}

function probe(url: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      // Consume response body so the socket can be freed
      res.resume();
      const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
      resolve(ok);
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Health check request timed out"));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
