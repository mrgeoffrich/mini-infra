/**
 * Upstream DNS forwarder.
 *
 * Tries each upstream resolver in order. Per-query timeout enforced.
 * Tracks last success/failure timestamps for /admin/health.
 */

import * as dgram from "dgram";
import { config } from "./config";
import { logger } from "./logging";
import { recordUpstreamFailure, recordUpstreamSuccess } from "./state";

// We work with raw DNS wire-format buffers when forwarding.

export interface ForwardResult {
  responseBuffer: Buffer;
  upstreamMs: number;
}

/**
 * Forward a raw DNS query buffer to upstream resolvers in order.
 * Returns the response buffer from the first server that replies.
 * Throws if all upstream servers fail or timeout.
 */
export async function forwardToUpstream(
  queryBuffer: Buffer,
  upstreamServers?: string[],
): Promise<ForwardResult> {
  const servers = upstreamServers ?? config.upstreamDns;
  let lastError: Error | null = null;

  for (const server of servers) {
    const start = Date.now();
    try {
      const responseBuffer = await queryUpstream(
        queryBuffer,
        server,
        config.queryTimeoutMs,
      );
      const upstreamMs = Date.now() - start;
      recordUpstreamSuccess();
      return { responseBuffer, upstreamMs };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn({ server, err: lastError.message }, "upstream-failover");
      recordUpstreamFailure();
    }
  }

  throw lastError ?? new Error("All upstream DNS servers failed");
}

/**
 * Send a raw DNS query buffer to a single upstream server via UDP.
 * Returns the raw DNS response buffer.
 */
function queryUpstream(
  queryBuffer: Buffer,
  server: string,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const cleanup = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
    };

    const timer = setTimeout(() => {
      cleanup(new Error(`Upstream DNS timeout: ${server}`));
    }, timeoutMs);

    socket.on("error", (err) => cleanup(err));

    socket.on("message", (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(msg);
    });

    socket.send(queryBuffer, 0, queryBuffer.length, 53, server, (err) => {
      if (err) cleanup(err);
    });
  });
}
