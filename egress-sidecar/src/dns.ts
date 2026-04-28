/**
 * DNS server (UDP + TCP) using dns2.
 *
 * Resolution path per incoming query:
 * 1. Identify source IP from socket rinfo.
 * 2. Look up source IP in container map -> { stackId, serviceName }.
 * 3. If no stackId or no policy -> forward upstream (permissive default). Log observed.
 * 4. If policy exists:
 *    - detect mode: always forward; log observed with wouldHaveBeen.
 *    - enforce mode:
 *      - AAAA: return NXDOMAIN; log blocked/aaaa-disabled.
 *      - A:    match policy; allow -> forward; block -> NXDOMAIN.
 *      - other: forward upstream; log observed.
 * 5. On upstream error: return SERVFAIL; log observed/upstream-error.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dns2 = require("dns2");
const { Packet } = dns2;

import { config } from "./config";
import { logger, getDedupLogger, buildQueryLogEntry } from "./logging";
import { getState, recordQuery } from "./state";
import { matchPolicy } from "./rules";
import { forwardToUpstream } from "./upstream";

// RCODE values (RFC 1035)
const RCODE_NXDOMAIN = 3;
const RCODE_SERVFAIL = 2;

// Qtype numeric IDs
const QTYPE_A = 1;
const QTYPE_AAAA = 28;

function qtypeToString(qtype: number): string {
  const map: Record<number, string> = {
    1: "A",
    2: "NS",
    5: "CNAME",
    6: "SOA",
    15: "MX",
    16: "TXT",
    28: "AAAA",
    33: "SRV",
    255: "ANY",
  };
  return map[qtype] ?? String(qtype);
}

interface DnsQuestion {
  name: string;
  type: number;
  class: number;
}

interface DnsRequest {
  header: { id: number; rd: number; rcode: number; qr: number };
  questions: DnsQuestion[];
  toBuffer(): Buffer;
}

interface SendFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (response: any): void;
}

interface RInfo {
  address: string;
  port: number;
}

async function handleRequest(
  request: DnsRequest,
  send: SendFn,
  rinfo: RInfo,
): Promise<void> {
  const srcIp = rinfo.address;
  const dedupLogger = getDedupLogger();
  const state = getState();

  // Get first question (standard queries have exactly one).
  const question = request.questions[0];
  if (!question) {
    // Malformed — ignore.
    return;
  }

  const qname = question.name.toLowerCase().replace(/\.$/, "");
  const qtypeNum = question.type;
  const qtype = qtypeToString(qtypeNum);

  // Look up source in container map.
  const containerEntry = state.containerMap.get(srcIp);
  const stackId = containerEntry?.stackId ?? null;
  const serviceName = containerEntry?.serviceName ?? null;

  // Look up compiled policy.
  const compiledPolicy = stackId ? state.stackPolicies.get(stackId) : null;

  if (!compiledPolicy || !stackId) {
    // No policy — forward upstream. Treat as observed (unmanaged source).
    await forwardOrServfail(
      request,
      send,
      srcIp,
      qname,
      qtype,
      "observed",
      stackId,
      serviceName,
      { reason: "no-policy" },
      state.defaultUpstreamOverride ?? undefined,
    );
    recordQuery("observed", qtype, srcIp, false);
    return;
  }

  const { policy, trie } = compiledPolicy;

  if (policy.mode === "detect") {
    // Detect mode: always forward, but log what would have happened.
    const { action: wouldHaveBeenAction, matchedPattern } = matchPolicy(
      trie,
      policy,
      qname,
      serviceName,
    );
    // Map "allow"/"block" to "allowed"/"blocked" for the log entry.
    const wouldHaveBeen: "allowed" | "blocked" =
      wouldHaveBeenAction === "allow" ? "allowed" : "blocked";
    const logEntry = buildQueryLogEntry({
      srcIp,
      qname,
      qtype,
      action: "observed",
      matchedPattern,
      wouldHaveBeen,
      stackId,
      serviceName,
    });
    await forwardOrServfail(
      request,
      send,
      srcIp,
      qname,
      qtype,
      "observed",
      stackId,
      serviceName,
      { existingLogEntry: logEntry },
      state.defaultUpstreamOverride ?? undefined,
    );
    dedupLogger.logQuery(logEntry);
    recordQuery("observed", qtype, srcIp, false);
    return;
  }

  // Enforce mode.

  // AAAA: always block (IPv4-only in v1).
  if (qtypeNum === QTYPE_AAAA) {
    const response = Packet.createResponseFromRequest(request);
    response.header.rcode = RCODE_NXDOMAIN;
    response.header.ra = 1;
    send(response);

    dedupLogger.logQuery(
      buildQueryLogEntry({
        srcIp,
        qname,
        qtype,
        action: "blocked",
        stackId,
        serviceName,
        reason: "aaaa-disabled",
      }),
    );
    recordQuery("blocked", qtype, srcIp, false);
    return;
  }

  // A queries: apply policy.
  if (qtypeNum === QTYPE_A) {
    const { action: effectiveAction, matchedPattern } = matchPolicy(
      trie,
      policy,
      qname,
      serviceName,
    );
    const reason =
      matchedPattern === null ? "default-action" : undefined;

    if (effectiveAction === "block") {
      const response = Packet.createResponseFromRequest(request);
      response.header.rcode = RCODE_NXDOMAIN;
      response.header.ra = 1;
      send(response);

      dedupLogger.logQuery(
        buildQueryLogEntry({
          srcIp,
          qname,
          qtype,
          action: "blocked",
          matchedPattern,
          stackId,
          serviceName,
          reason,
        }),
      );
      recordQuery("blocked", qtype, srcIp, false);
      return;
    }

    // Allow — forward upstream.
    await forwardOrServfail(
      request,
      send,
      srcIp,
      qname,
      qtype,
      "allowed",
      stackId,
      serviceName,
      { matchedPattern, reason },
      state.defaultUpstreamOverride ?? undefined,
    );
    recordQuery("allowed", qtype, srcIp, false);
    return;
  }

  // Other query types — forward upstream (we can't reasonably block by name in v1).
  await forwardOrServfail(
    request,
    send,
    srcIp,
    qname,
    qtype,
    "observed",
    stackId,
    serviceName,
    {},
    state.defaultUpstreamOverride ?? undefined,
  );
  recordQuery("observed", qtype, srcIp, false);
}

/** Forward to upstream; on error return SERVFAIL and log upstream-error. */
async function forwardOrServfail(
  request: DnsRequest,
  send: SendFn,
  srcIp: string,
  qname: string,
  qtype: string,
  action: "allowed" | "blocked" | "observed",
  stackId: string | null,
  serviceName: string | null,
  extra: {
    matchedPattern?: string | null;
    reason?: "no-policy" | "default-action" | "upstream-error";
    existingLogEntry?: ReturnType<typeof buildQueryLogEntry>;
  },
  upstreamOverride?: string[],
): Promise<void> {
  const dedupLogger = getDedupLogger();
  try {
    const queryBuffer = request.toBuffer();
    const { responseBuffer, upstreamMs } = await forwardToUpstream(
      queryBuffer,
      upstreamOverride,
    );

    // Send the raw buffer back — dns2 UDP/TCP servers accept raw Buffers too.
    send(responseBuffer);

    if (!extra.existingLogEntry) {
      dedupLogger.logQuery(
        buildQueryLogEntry({
          srcIp,
          qname,
          qtype,
          action,
          matchedPattern: extra.matchedPattern,
          stackId,
          serviceName,
          upstreamMs,
          reason: extra.reason,
        }),
      );
    } else {
      // Patch upstreamMs into the pre-built log entry and emit it.
      dedupLogger.logQuery({
        ...extra.existingLogEntry,
        upstreamMs,
      });
    }
  } catch (err) {
    logger.warn({ err, srcIp, qname, qtype }, "upstream failed — returning SERVFAIL");
    const response = Packet.createResponseFromRequest(request);
    response.header.rcode = RCODE_SERVFAIL;
    response.header.ra = 1;
    send(response);

    dedupLogger.logQuery(
      buildQueryLogEntry({
        srcIp,
        qname,
        qtype,
        action: "observed",
        stackId,
        serviceName,
        reason: "upstream-error",
      }),
    );
    recordQuery("observed", qtype, srcIp, true);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: ReturnType<typeof dns2.createServer> | null = null;

export function startDnsServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server = dns2.createServer({ udp: true, tcp: true });

    server.on("request", (request: DnsRequest, send: SendFn, rinfo: RInfo) => {
      handleRequest(request, send, rinfo).catch((err) => {
        logger.error({ err }, "unhandled error in DNS request handler");
      });
    });

    server.on("requestError", (err: Error) => {
      logger.warn({ err }, "DNS request parse error");
    });

    server.on("error", (err: Error, type: string) => {
      logger.error({ err, type }, "DNS server error");
      reject(err);
    });

    server
      .listen({
        udp: { port: config.dnsPort, address: "0.0.0.0" },
        tcp: { port: config.dnsPort, address: "0.0.0.0" },
      })
      .then(() => {
        logger.info({ port: config.dnsPort }, "DNS server listening (UDP+TCP)");
        resolve();
      })
      .catch(reject);
  });
}

export async function stopDnsServer(): Promise<void> {
  if (server) {
    await server.close();
    server = null;
  }
}
