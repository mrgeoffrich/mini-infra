/**
 * Structured JSON stdout logger with per-key dedup windowing.
 *
 * DNS query decisions are rate-limited: only one line per (srcIp|qname|qtype|action)
 * key is emitted per DEDUP_WINDOW_MS. Suppressed events bump a hit counter; the next
 * emission (or a 5s periodic flush) includes the accumulated `mergedHits`.
 *
 * Operational events (startup, shutdown, admin.*) are never deduped.
 */

import pino from "pino";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Pino logger — operational logs
// ---------------------------------------------------------------------------

export const logger = pino({
  name: "mini-infra-egress-sidecar",
  level: config.logLevel,
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

// ---------------------------------------------------------------------------
// Structured DNS query log line shape
// ---------------------------------------------------------------------------

export interface DnsQueryLogEntry {
  ts: string;
  level: "info";
  evt: "dns.query";
  srcIp: string;
  qname: string;
  qtype: string;
  action: "allowed" | "blocked" | "observed";
  matchedPattern?: string;
  wouldHaveBeen?: "allowed" | "blocked";
  stackId?: string;
  serviceName?: string;
  upstreamMs?: number;
  reason?: "aaaa-disabled" | "upstream-error" | "no-policy" | "default-action";
  mergedHits: number;
}

export interface OperationalLogEntry {
  ts: string;
  level: "info" | "warn" | "error" | "debug";
  evt: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Dedup window bucket
// ---------------------------------------------------------------------------

interface DedupBucket {
  hits: number;
  firstEntry: DnsQueryLogEntry;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// Logger class — injectable clock for testing
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export class DedupLogger {
  private buckets: Map<string, DedupBucket> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly windowMs: number;
  private readonly clock: Clock;

  constructor(windowMs: number = config.dedupWindowMs, clock: Clock = systemClock) {
    this.windowMs = windowMs;
    this.clock = clock;
    this._startFlushTimer();
  }

  private _startFlushTimer(): void {
    // Flush leftover buckets every 5 seconds.
    this.flushTimer = setInterval(() => {
      this._flushExpired();
    }, 5000);
    // Don't let this timer keep the process alive.
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  private _bucketKey(entry: DnsQueryLogEntry): string {
    return `${entry.srcIp}|${entry.qname}|${entry.qtype}|${entry.action}`;
  }

  /**
   * Emit a DNS query log line, subject to dedup windowing.
   */
  logQuery(entry: DnsQueryLogEntry): void {
    const now = this.clock.now();
    const key = this._bucketKey(entry);
    const existing = this.buckets.get(key);

    if (existing && now - existing.windowStart < this.windowMs) {
      // Within the window — suppress and count.
      existing.hits += 1;
      return;
    }

    if (existing) {
      // Window expired — emit a summary line if there were suppressed hits beyond the
      // first (which was already emitted immediately). hits=1 means no suppression occurred.
      if (existing.hits > 1) {
        this._emitQueryLine({ ...existing.firstEntry, mergedHits: existing.hits });
      }
    }

    // Start a new bucket for this key. Don't emit yet — we emit when the window expires
    // or on shutdown. But the very first hit IS emitted immediately so the log isn't silent.
    // Rationale: emit on first occurrence so mini-infra-server sees decisions promptly.
    this._emitQueryLine(entry);
    this.buckets.set(key, {
      hits: 1,
      firstEntry: entry,
      windowStart: now,
    });
  }

  /**
   * Emit an operational log line (never deduped).
   */
  logOperational(entry: OperationalLogEntry): void {
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  /** Force-flush all pending buckets. Call on shutdown. */
  flush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this._flushExpired(true);
  }

  private _flushExpired(all = false): void {
    const now = this.clock.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (all || now - bucket.windowStart >= this.windowMs) {
        if (bucket.hits > 1) {
          // Emit a summary line with accumulated hits.
          this._emitQueryLine({ ...bucket.firstEntry, mergedHits: bucket.hits });
        }
        this.buckets.delete(key);
      }
    }
  }

  private _emitQueryLine(entry: DnsQueryLogEntry): void {
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  /** Exposed for testing — number of active buckets. */
  get activeBuckets(): number {
    return this.buckets.size;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _dedupLogger: DedupLogger | null = null;

export function getDedupLogger(): DedupLogger {
  if (!_dedupLogger) {
    _dedupLogger = new DedupLogger();
  }
  return _dedupLogger;
}

/** Replace the singleton (for tests). */
export function setDedupLogger(instance: DedupLogger): void {
  _dedupLogger = instance;
}

// ---------------------------------------------------------------------------
// Helper to build a query log entry
// ---------------------------------------------------------------------------

export function buildQueryLogEntry(params: {
  srcIp: string;
  qname: string;
  qtype: string;
  action: "allowed" | "blocked" | "observed";
  matchedPattern?: string | null;
  wouldHaveBeen?: "allowed" | "blocked";
  stackId?: string | null;
  serviceName?: string | null;
  upstreamMs?: number;
  reason?: DnsQueryLogEntry["reason"];
}): DnsQueryLogEntry {
  const entry: DnsQueryLogEntry = {
    ts: new Date().toISOString(),
    level: "info",
    evt: "dns.query",
    srcIp: params.srcIp,
    qname: params.qname,
    qtype: params.qtype,
    action: params.action,
    mergedHits: 1,
  };
  if (params.matchedPattern) entry.matchedPattern = params.matchedPattern;
  if (params.wouldHaveBeen) entry.wouldHaveBeen = params.wouldHaveBeen;
  if (params.stackId) entry.stackId = params.stackId;
  if (params.serviceName) entry.serviceName = params.serviceName;
  if (params.upstreamMs !== undefined) entry.upstreamMs = params.upstreamMs;
  if (params.reason) entry.reason = params.reason;
  return entry;
}
