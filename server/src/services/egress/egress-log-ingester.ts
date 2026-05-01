/**
 * EgressLogIngester
 *
 * Tails each egress-gateway container's stdout AND the host-singleton
 * fw-agent container's stdout, and ingests structured log lines as
 * EgressEvent rows.
 *
 * Architecture
 * ─────────────
 * • One GatewayTailer per environment. Tails stdout of the container
 *   named `{envName}-egress-gateway-egress-gateway`.
 * • One FwAgentTailer (host singleton). Tails stdout of the container
 *   labelled `mini-infra.egress.fw-agent=true`.
 * • Lines are parsed as NDJSON. Handled event types:
 *   - evt === 'dns.query'  — existing DNS-query events
 *   - evt === 'tcp'        — HTTPS CONNECT (protocol: "connect") and HTTP forward
 *                            proxy (protocol: "http") events from the gateway
 *   - evt === 'fw_drop'    — firewall drop events from the fw-agent
 *   All other evt values are silently skipped.
 * • Policy lookup: each line carries a stackId; we find the EgressPolicy
 *   whose stack.id matches. Lines without a stackId, or where no policy
 *   is found, are dropped (single rate-limited warn).
 * • Server-side dedup window (60 s) collapses repeated events.
 *   Dedup keys:
 *   - dns:     policyId:service:destination:action
 *   - tcp:     policyId:service:target:action
 *   - fw_drop: policyId:service:destIp:destPort:protocol
 * • EgressEvent rows are batch-inserted every ~1 s or when the batch hits
 *   100 rows.
 * • EgressRule.hits is bumped when a matchedPattern maps to an existing rule.
 *
 * Log line formats:
 *   dns.query: { ts, level, evt, srcIp, qname, qtype, action, matchedPattern?,
 *                wouldHaveBeen?, stackId?, serviceName?, reason?, mergedHits }
 *   tcp:       { ts, evt, protocol, srcIp, target, action, reason?, matchedPattern?,
 *                stackId?, serviceName?, bytesUp?, bytesDown?, method?, path?,
 *                status?, mergedHits }
 *   fw_drop:   { ts, evt, protocol, srcIp, destIp, destPort, stackId?,
 *                serviceName?, reason?, mergedHits }
 */

import { Readable } from 'stream';
import { EgressGwSubject, NatsConsumer, NatsStream } from '@mini-infra/types';
import type { PrismaClient } from '../../generated/prisma/client';
// Phase 2 (ALT-27) + Phase 3 (ALT-28) made both ingest paths bus-driven —
// no Docker container-event listener needed; JetStream durable consumers
// auto-resume from last-acked sequence on reconnect.
import { DockerStreamDemuxer } from '../../lib/docker-stream';
import { getLogger } from '../../lib/logger-factory';
import { NatsBus } from '../nats/nats-bus';
import type { EgressGwDecision } from '../nats/payload-schemas';
import { emitEgressEvent } from './egress-socket-emitter';
import type { EgressFwEvent } from '../nats/payload-schemas';

const log = getLogger('stacks', 'egress-log-ingester');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_FLUSH_INTERVAL_MS = 1000;
const BATCH_MAX_ROWS = 100;
const DEDUP_WINDOW_MS = 60_000;
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60_000;
/** Rate-limit "no policy for stack" warnings to at most once per minute per stackId */
const WARN_COOL_DOWN_MS = 60_000;


// ---------------------------------------------------------------------------
// Parsed log-line shapes
// ---------------------------------------------------------------------------

interface DnsQueryLine {
  ts: string;
  level: string;
  evt: 'dns.query';
  srcIp: string;
  qname: string;
  qtype: string;
  action: 'allowed' | 'blocked' | 'observed';
  matchedPattern?: string;
  wouldHaveBeen?: 'allowed' | 'blocked';
  stackId?: string;
  serviceName?: string;
  reason?: string;
  mergedHits: number;
}

interface TcpConnectLine {
  ts: string;
  evt: 'tcp';
  protocol: 'connect';
  srcIp: string;
  target: string;
  action: 'allowed' | 'blocked';
  reason?: string;
  matchedPattern?: string;
  stackId?: string;
  serviceName?: string;
  bytesUp?: number;
  bytesDown?: number;
  mergedHits: number;
}

interface TcpHttpLine {
  ts: string;
  evt: 'tcp';
  protocol: 'http';
  srcIp: string;
  target: string;
  method: string;
  path: string;
  action: 'allowed' | 'blocked';
  reason?: string;
  matchedPattern?: string;
  stackId?: string;
  serviceName?: string;
  status?: number;
  bytesDown?: number;
  mergedHits: number;
}

interface FwDropLine {
  ts: string;
  evt: 'fw_drop';
  protocol: 'tcp' | 'udp' | 'icmp';
  srcIp: string;
  destIp: string;
  destPort?: number;
  stackId?: string;
  serviceName?: string;
  reason?: string;
  mergedHits: number;
}

// ---------------------------------------------------------------------------
// In-memory dedup bucket
// ---------------------------------------------------------------------------

interface DedupBucket {
  /** Accumulated hit count (from gateway mergedHits values) */
  hits: number;
  /** Timestamp of first sighting in this window */
  windowStart: number;
  /** Whether the "first" row has already been flushed to DB */
  initialRowFlushed: boolean;
}

type DedupKey = string;

/** Cached policy context needed for socket emissions */
interface PolicyContext {
  id: string;
  stackNameSnapshot: string;
  environmentNameSnapshot: string;
  environmentId: string | null;
}

function makeDedupKey(
  policyId: string,
  serviceName: string | undefined,
  destination: string,
  action: string,
): DedupKey {
  return `${policyId}:${serviceName ?? ''}:${destination}:${action}`;
}

function makeFwDropDedupKey(
  policyId: string,
  serviceName: string | undefined,
  srcIp: string,
  destIp: string,
  destPort: number | undefined,
  protocol: string,
): DedupKey {
  return `${policyId}:${serviceName ?? ''}:${srcIp}:${destIp}:${destPort ?? ''}:${protocol}`;
}

// ---------------------------------------------------------------------------
// Row to insert
// ---------------------------------------------------------------------------

interface PendingRow {
  policyId: string;
  occurredAt: Date;
  sourceContainerId?: string;
  sourceStackId?: string;
  sourceServiceName?: string;
  destination: string;
  matchedPattern?: string;
  action: string;
  protocol: string;
  mergedHits: number;
  /** Snapshot fields carried alongside so _flushBatch can emit without a DB lookup */
  stackNameSnapshot: string;
  environmentNameSnapshot: string;
  environmentId: string | null;
  // v3 egress gateway fields
  target?: string;
  method?: string;
  path?: string;
  status?: number;
  bytesUp?: bigint;
  bytesDown?: bigint;
  destIp?: string;
  destPort?: number;
  reason?: string;
  /**
   * Optional acknowledgement callbacks invoked after the batch is committed
   * to the EgressEvent table. JetStream consumers attach a `msg.ack()` here
   * so a server crash mid-flush triggers redelivery rather than silent loss.
   * Null for log-tailed sources (Docker log-attach has no ack model — losses
   * are inherent to that transport, which is exactly why Phase 3 moved off
   * it for the gateway).
   */
  ackOnFlush?: () => void;
}

// ---------------------------------------------------------------------------
// Shared tailer logic — base class
// ---------------------------------------------------------------------------

abstract class BaseTailer {
  protected stream: Readable | null = null;
  protected stopped = false;
  protected reconnectDelay = RECONNECT_BASE_DELAY_MS;

  /** In-memory dedup: key → bucket */
  protected readonly dedupBuckets = new Map<DedupKey, DedupBucket>();
  /** Pending rows waiting to be inserted */
  protected readonly pendingRows: PendingRow[] = [];
  /** Timer for dedup-window rolls and batch flush */
  protected batchTimer: NodeJS.Timeout | null = null;
  /** Rate-limiter for "no policy" warnings: stackId → last warn time */
  protected readonly warnCooldowns = new Map<string, number>();
  /**
   * Cache of policy context (snapshot fields + environmentId) keyed by stackId.
   * Keyed by stackId so that _lookupPolicy can hit the cache before knowing policyId.
   * Stack count is bounded by realistic deployment size — no eviction needed for v1.
   */
  protected readonly policyContextCache = new Map<string, PolicyContext>();

  constructor(protected readonly prisma: PrismaClient) {}

  stop(): void {
    this.stopped = true;
    this._destroyStream();
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    // Flush remaining batched rows (best-effort, fire-and-forget)
    void this._flushBatch();
  }

  // -------------------------------------------------------------------------
  // Stream lifecycle
  // -------------------------------------------------------------------------

  protected _destroyStream(): void {
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
  }

  protected _scheduleReconnect(contextLabel: string): void {
    if (this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    log.debug({ contextLabel, delayMs: delay }, 'Scheduling log reconnect');
    setTimeout(() => void this._connect(), delay);
  }

  protected abstract _connect(): Promise<void>;

  // -------------------------------------------------------------------------
  // Stream setup helper — shared between gateway and fw-agent tailers
  // -------------------------------------------------------------------------

  protected _attachStream(rawStream: Readable, contextLabel: string): void {
    this.stream = rawStream;
    this.reconnectDelay = RECONNECT_BASE_DELAY_MS; // reset on success

    const demuxer = new DockerStreamDemuxer();
    let lineBuffer = '';

    rawStream.on('data', (chunk: Buffer) => {
      for (const frame of demuxer.push(chunk)) {
        if (frame.stream !== 'stdout') continue;
        lineBuffer += frame.data.toString('utf-8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            this._handleLine(line.trim());
          }
        }
      }
    });

    rawStream.on('end', () => {
      log.debug({ contextLabel }, 'Log stream ended — reconnecting');
      this._destroyStream();
      this._scheduleReconnect(contextLabel);
    });

    rawStream.on('error', (err: Error) => {
      log.warn({ err: err.message, contextLabel }, 'Log stream error — reconnecting');
      this._destroyStream();
      this._scheduleReconnect(contextLabel);
    });
  }

  // -------------------------------------------------------------------------
  // Line parsing
  // -------------------------------------------------------------------------

  protected _handleLine(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) return;

    const evt = (parsed as Record<string, unknown>).evt as string | undefined;

    if (evt === 'dns.query') {
      const line = parsed as DnsQueryLine;
      if (!line.srcIp || !line.qname || !line.action) return;
      void this._ingestDnsQuery(line);
    } else if (evt === 'tcp') {
      const line = parsed as TcpConnectLine | TcpHttpLine;
      if (!line.srcIp || !line.target || !line.action) return;
      if (line.protocol === 'connect') {
        void this._ingestTcpConnect(line as TcpConnectLine);
      } else if (line.protocol === 'http') {
        void this._ingestTcpHttp(line as TcpHttpLine);
      }
      // Other protocol values are silently skipped
    } else if (evt === 'fw_drop') {
      const line = parsed as FwDropLine;
      if (!line.srcIp || !line.destIp || !line.protocol) return;
      void this._ingestFwDrop(line);
    }
    // All other evt values are silently skipped
  }

  // -------------------------------------------------------------------------
  // Policy lookup helper
  // -------------------------------------------------------------------------

  protected async _lookupPolicy(stackId: string): Promise<PolicyContext | null> {
    // Cache is keyed by stackId — O(1) lookup with no fallthrough to DB on hit
    const cached = this.policyContextCache.get(stackId);
    if (cached) return cached;

    try {
      const policy = await this.prisma.egressPolicy.findFirst({
        where: { stackId, archivedAt: null },
        select: {
          id: true,
          stackNameSnapshot: true,
          environmentNameSnapshot: true,
          environmentId: true,
        },
      });
      if (!policy) return null;

      const ctx: PolicyContext = {
        id: policy.id,
        stackNameSnapshot: policy.stackNameSnapshot,
        environmentNameSnapshot: policy.environmentNameSnapshot,
        environmentId: policy.environmentId,
      };
      this.policyContextCache.set(stackId, ctx);
      return ctx;
    } catch (err) {
      log.warn({ err, stackId }, 'EgressPolicy lookup failed — dropping event');
      return null;
    }
  }

  protected _warnNoPolicyIfNeeded(stackId: string, evtType: string, srcIp: string): void {
    const now = Date.now();
    const lastWarn = this.warnCooldowns.get(stackId) ?? 0;
    if (now - lastWarn > WARN_COOL_DOWN_MS) {
      log.warn(
        { stackId, srcIp, evtType },
        'No active EgressPolicy for stackId — dropping event',
      );
      this.warnCooldowns.set(stackId, now);
    }
  }

  // -------------------------------------------------------------------------
  // Dedup helpers
  // -------------------------------------------------------------------------

  /**
   * Returns true if this event should be suppressed (within dedup window).
   * Also updates bucket state and pushes the rolled-up row if the window expired.
   *
   * `ackIfSuppressed` lets JetStream-sourced ingest paths acknowledge a
   * message that's been "absorbed" into an existing dedup bucket (no row
   * queued, but the message must still be acked so JetStream doesn't
   * redeliver it). For row-producing paths the ack instead rides on the
   * `ackOnFlush` field of the queued PendingRow.
   */
  protected _checkDedup(
    key: DedupKey,
    mergedHits: number,
    rowFactory: () => PendingRow,
    ackIfSuppressed?: () => void,
  ): boolean {
    const now = Date.now();
    const bucket = this.dedupBuckets.get(key);

    if (bucket && now - bucket.windowStart < DEDUP_WINDOW_MS) {
      // Within window — accumulate, suppress new row. Ack the underlying
      // JetStream message (if any) so it isn't redelivered — the bucket
      // already has its hit count.
      bucket.hits += mergedHits;
      try {
        ackIfSuppressed?.();
      } catch {
        // best-effort
      }
      return true;
    }

    if (bucket && now - bucket.windowStart >= DEDUP_WINDOW_MS) {
      // Window expired — we could write a roll-up; for v1 simplicity we just clear.
      // Log safe fields only — the raw key may contain HTTP paths with sensitive data.
      log.debug({ hits: bucket.hits }, 'Dedup window expired — bucket cleared');
    }

    // Start new window
    this.dedupBuckets.set(key, {
      hits: mergedHits,
      windowStart: now,
      initialRowFlushed: true,
    });

    // Queue the initial row
    this.pendingRows.push(rowFactory());
    this._maybeFlushBatch();
    return false;
  }

  // -------------------------------------------------------------------------
  // Ingestion methods — one per event type
  // -------------------------------------------------------------------------

  /**
   * `ack`, when supplied, is the JetStream message ack callback. It rides on
   * the `PendingRow.ackOnFlush` field for non-suppressed events and is
   * invoked directly by `_checkDedup` for suppressed (within-window) events.
   * Pre-policy-lookup drop paths (no stackId, no policy match) ack
   * immediately — the message is a no-op so JetStream shouldn't redeliver.
   */
  protected async _ingestDnsQuery(line: DnsQueryLine, ack?: () => void): Promise<void> {
    if (!line.stackId) {
      ack?.();
      return;
    }

    const policyContext = await this._lookupPolicy(line.stackId);
    if (!policyContext) {
      this._warnNoPolicyIfNeeded(line.stackId, 'dns.query', line.srcIp);
      ack?.();
      return;
    }

    const key = makeDedupKey(policyContext.id, line.serviceName, line.qname, line.action);
    const suppressed = this._checkDedup(
      key,
      line.mergedHits,
      () => ({
        policyId: policyContext.id,
        occurredAt: line.ts ? new Date(line.ts) : new Date(),
        sourceStackId: line.stackId,
        sourceServiceName: line.serviceName,
        destination: line.qname,
        matchedPattern: line.matchedPattern,
        action: line.action,
        protocol: 'dns',
        mergedHits: line.mergedHits,
        stackNameSnapshot: policyContext.stackNameSnapshot,
        environmentNameSnapshot: policyContext.environmentNameSnapshot,
        environmentId: policyContext.environmentId,
        ackOnFlush: ack,
      }),
      ack,
    );

    if (!suppressed && line.matchedPattern) {
      void this._bumpRuleHits(policyContext.id, line.matchedPattern);
    }
  }

  protected async _ingestTcpConnect(line: TcpConnectLine, ack?: () => void): Promise<void> {
    if (!line.stackId) {
      ack?.();
      return;
    }

    const policyContext = await this._lookupPolicy(line.stackId);
    if (!policyContext) {
      this._warnNoPolicyIfNeeded(line.stackId, 'tcp/connect', line.srcIp);
      ack?.();
      return;
    }

    const key = makeDedupKey(policyContext.id, line.serviceName, line.target, line.action);
    const suppressed = this._checkDedup(
      key,
      line.mergedHits,
      () => ({
        policyId: policyContext.id,
        occurredAt: line.ts ? new Date(line.ts) : new Date(),
        sourceStackId: line.stackId,
        sourceServiceName: line.serviceName,
        destination: line.target, // use target as destination for list/filter UI
        target: line.target,
        matchedPattern: line.matchedPattern,
        action: line.action,
        protocol: 'connect',
        mergedHits: line.mergedHits,
        bytesUp: line.bytesUp !== undefined ? BigInt(line.bytesUp) : undefined,
        bytesDown: line.bytesDown !== undefined ? BigInt(line.bytesDown) : undefined,
        reason: line.reason,
        stackNameSnapshot: policyContext.stackNameSnapshot,
        environmentNameSnapshot: policyContext.environmentNameSnapshot,
        environmentId: policyContext.environmentId,
        ackOnFlush: ack,
      }),
      ack,
    );

    if (!suppressed && line.matchedPattern) {
      void this._bumpRuleHits(policyContext.id, line.matchedPattern);
    }
  }

  protected async _ingestTcpHttp(line: TcpHttpLine, ack?: () => void): Promise<void> {
    if (!line.stackId) {
      ack?.();
      return;
    }

    const policyContext = await this._lookupPolicy(line.stackId);
    if (!policyContext) {
      this._warnNoPolicyIfNeeded(line.stackId, 'tcp/http', line.srcIp);
      ack?.();
      return;
    }

    const key = makeDedupKey(policyContext.id, line.serviceName, line.target, line.action);
    const suppressed = this._checkDedup(
      key,
      line.mergedHits,
      () => ({
        policyId: policyContext.id,
        occurredAt: line.ts ? new Date(line.ts) : new Date(),
        sourceStackId: line.stackId,
        sourceServiceName: line.serviceName,
        destination: line.target, // use target as destination for list/filter UI
        target: line.target,
        method: line.method,
        path: line.path,
        status: line.status,
        bytesDown: line.bytesDown !== undefined ? BigInt(line.bytesDown) : undefined,
        matchedPattern: line.matchedPattern,
        action: line.action,
        protocol: 'http',
        mergedHits: line.mergedHits,
        reason: line.reason,
        stackNameSnapshot: policyContext.stackNameSnapshot,
        environmentNameSnapshot: policyContext.environmentNameSnapshot,
        environmentId: policyContext.environmentId,
        ackOnFlush: ack,
      }),
      ack,
    );

    if (!suppressed && line.matchedPattern) {
      void this._bumpRuleHits(policyContext.id, line.matchedPattern);
    }
  }

  protected async _ingestFwDrop(line: FwDropLine, ack?: () => void): Promise<void> {
    if (!line.stackId) {
      // fw_drop without stackId cannot be attributed — drop it
      ack?.();
      return;
    }

    const policyContext = await this._lookupPolicy(line.stackId);
    if (!policyContext) {
      this._warnNoPolicyIfNeeded(line.stackId, 'fw_drop', line.srcIp);
      ack?.();
      return;
    }

    const destLabel = line.destPort ? `${line.destIp}:${line.destPort}` : line.destIp;
    const key = makeFwDropDedupKey(
      policyContext.id,
      line.serviceName,
      line.srcIp,
      line.destIp,
      line.destPort,
      line.protocol,
    );
    const suppressed = this._checkDedup(
      key,
      line.mergedHits,
      () => ({
        policyId: policyContext.id,
        occurredAt: line.ts ? new Date(line.ts) : new Date(),
        sourceStackId: line.stackId,
        sourceServiceName: line.serviceName,
        destination: destLabel, // destIp:destPort for list/filter UI
        destIp: line.destIp,
        destPort: line.destPort,
        action: 'blocked',
        protocol: line.protocol,
        mergedHits: line.mergedHits,
        reason: line.reason,
        stackNameSnapshot: policyContext.stackNameSnapshot,
        environmentNameSnapshot: policyContext.environmentNameSnapshot,
        environmentId: policyContext.environmentId,
        ackOnFlush: ack,
      }),
      ack,
    );
    if (suppressed) return;
    // fw_drop has no matchedPattern — no rule hit bump
  }

  // -------------------------------------------------------------------------
  // Batch flush
  // -------------------------------------------------------------------------

  protected _maybeFlushBatch(): void {
    if (this.pendingRows.length >= BATCH_MAX_ROWS) {
      void this._flushBatch();
    }
  }

  protected _startBatchTimer(): void {
    this.batchTimer = setInterval(() => {
      this._rollExpiredDedupWindows();
      if (this.pendingRows.length > 0) {
        void this._flushBatch();
      }
    }, BATCH_FLUSH_INTERVAL_MS);
  }

  protected _rollExpiredDedupWindows(): void {
    const now = Date.now();
    for (const [key, bucket] of this.dedupBuckets.entries()) {
      if (now - bucket.windowStart >= DEDUP_WINDOW_MS) {
        // Log safe fields only — the raw key may contain HTTP paths with sensitive data.
        log.debug(
          { hits: bucket.hits },
          'Dedup window expired — bucket cleared (timer roll)',
        );
        this.dedupBuckets.delete(key);
      }
    }
  }

  protected async _flushBatch(): Promise<void> {
    if (this.pendingRows.length === 0) return;

    const batch = this.pendingRows.splice(0, BATCH_MAX_ROWS);

    try {
      await this.prisma.egressEvent.createMany({
        data: batch.map((row) => ({
          policyId: row.policyId,
          occurredAt: row.occurredAt,
          sourceContainerId: row.sourceContainerId ?? null,
          sourceStackId: row.sourceStackId ?? null,
          sourceServiceName: row.sourceServiceName ?? null,
          destination: row.destination,
          matchedPattern: row.matchedPattern ?? null,
          action: row.action,
          protocol: row.protocol,
          mergedHits: row.mergedHits,
          target: row.target ?? null,
          method: row.method ?? null,
          path: row.path ?? null,
          status: row.status ?? null,
          bytesUp: row.bytesUp ?? null,
          bytesDown: row.bytesDown ?? null,
          destIp: row.destIp ?? null,
          destPort: row.destPort ?? null,
          reason: row.reason ?? null,
        })),
      });

      log.debug({ count: batch.length }, 'Flushed EgressEvent batch');

      // Successful insert: acknowledge any JetStream messages that
      // contributed to this batch. We do this before the socket emit so
      // JetStream's queue depth tracks the persisted state, not the UI
      // dispatch state. A `try/catch` around each ack guards against a
      // closed connection making the iteration throw and skipping later
      // acks — best-effort, dedup window absorbs any redelivery.
      for (const row of batch) {
        if (row.ackOnFlush) {
          try {
            row.ackOnFlush();
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'Failed to ack JetStream message after batch flush — JetStream will redeliver',
            );
          }
        }
      }

      // Emit one egress:event per row after successful batch insert.
      // createMany does not return IDs, so we synthesise placeholder IDs for
      // the socket event — the frontend uses these for live-feed display only.
      for (const row of batch) {
        try {
          emitEgressEvent({
            id: `${row.policyId}-${row.occurredAt.getTime()}`,
            policyId: row.policyId,
            occurredAt: row.occurredAt,
            sourceContainerId: row.sourceContainerId ?? null,
            sourceStackId: row.sourceStackId ?? null,
            sourceServiceName: row.sourceServiceName ?? null,
            destination: row.destination,
            matchedPattern: row.matchedPattern ?? null,
            action: row.action,
            protocol: row.protocol,
            mergedHits: row.mergedHits,
            stackNameSnapshot: row.stackNameSnapshot,
            environmentNameSnapshot: row.environmentNameSnapshot,
            environmentId: row.environmentId,
            target: row.target ?? null,
            method: row.method ?? null,
            path: row.path ?? null,
            status: row.status ?? null,
            bytesUp: row.bytesUp !== undefined ? Number(row.bytesUp) : null,
            bytesDown: row.bytesDown !== undefined ? Number(row.bytesDown) : null,
            destIp: row.destIp ?? null,
            destPort: row.destPort ?? null,
            reason: row.reason ?? null,
          });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Failed to emit egress socket event — continuing',
          );
        }
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), batchSize: batch.length },
        'Failed to flush EgressEvent batch — events dropped',
      );
    }
  }

  // -------------------------------------------------------------------------
  // EgressRule hit counter
  // -------------------------------------------------------------------------

  protected async _bumpRuleHits(policyId: string, pattern: string): Promise<void> {
    try {
      await this.prisma.egressRule.updateMany({
        where: { policyId, pattern },
        data: { hits: { increment: 1 }, lastHitAt: new Date() },
      });
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err), policyId, pattern },
        'Failed to bump EgressRule.hits (rule may have been deleted)',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// EgressDecisionsConsumer — single instance, drains the shared
// `EgressGwDecisions` JetStream stream across every environment.
// ---------------------------------------------------------------------------
//
// Replaces the per-environment Docker log-attach (`GatewayTailer`) that
// shipped before Phase 3. Compared to log-attach:
//
//  - decisions survive a gateway container restart (JetStream queues them
//    until we ack), which is the headline win in the ALT-28 acceptance
//    criteria;
//  - one consumer drains every env (the gateway uses environmentId in the
//    payload; the per-env discrimination lives there, not in the subject);
//  - acks ride on the PendingRow.ackOnFlush hook so the message stays in
//    the stream until the EgressEvent row is committed — flush failure
//    triggers JetStream redelivery rather than a silent drop.
//
// The consumer extends `BaseTailer` for its dedup/batch/policy-lookup
// machinery; the stream-attach methods (`_connect`, `_attachStream`,
// `_scheduleReconnect`) are inherited but unused here — JetStream
// reconnect is handled by `NatsBus`.
//
class EgressDecisionsConsumer extends BaseTailer {
  private cancel: (() => void) | null = null;

  constructor(prisma: PrismaClient) {
    super(prisma);
  }

  /**
   * Register the JetStream consumer and start the batch timer. The bus may
   * not be connected yet — `jsConsume` records the registration and the bus
   * will start the consume loop the moment the first connection is up. So
   * this method is fire-and-forget; the only failure mode is "bus not
   * initialised", which only happens in unit tests that opt out of the bus.
   */
  start(): void {
    if (this.cancel) return;
    this._startBatchTimer();
    try {
      const bus = NatsBus.getInstance();
      this.cancel = bus.jetstream.consume<EgressGwDecision>(
        {
          stream: NatsStream.egressGwDecisions,
          durable: NatsConsumer.egressGwDecisionsServer,
          // The stream captures `EgressGwSubject.decisions`. Pass it as the
          // filter so Zod validation runs on each delivery (the bus's
          // `subjectForSchema` falls back to the stream-namespaced key when
          // the filter is missing, which never matches `payloadSchemas`).
          filterSubject: EgressGwSubject.decisions,
        },
        async (decision, ctx) => {
          // Each decision arrives Zod-validated by the bus. Manual-ack: we
          // thread `ctx.ack` through `_ingest*` so the JetStream message
          // stays in-flight until either:
          //   - the decision is suppressed by dedup (ack inside _checkDedup), or
          //   - the EgressEvent row is committed by the next batch flush
          //     (ack runs in _flushBatch).
          // A handler exception leaves the message unacked; ack-wait
          // expires; JetStream redelivers; the dedup window catches the
          // duplicate. That's the chain that gives us "zero in-flight
          // decisions lost across gateway restart".
          await this._handleDecision(decision, ctx.ack);
        },
        { ack: 'manual' },
      );
      log.info(
        {
          stream: NatsStream.egressGwDecisions,
          consumer: NatsConsumer.egressGwDecisionsServer,
        },
        'Egress decisions consumer registered',
      );
    } catch (err) {
      // Bus not initialised — typically a unit test that mocks
      // EgressLogIngester without booting NatsBus. Log at info so the
      // production path is loud about it, but don't throw.
      log.info(
        { err: err instanceof Error ? err.message : String(err) },
        'Egress decisions consumer not started — NatsBus unavailable',
      );
    }
  }

  stop(): void {
    if (this.cancel) {
      try {
        this.cancel();
      } catch {
        // best-effort
      }
      this.cancel = null;
    }
    super.stop();
    log.info('Egress decisions consumer stopped');
  }

  /**
   * Required by the abstract `BaseTailer` contract. The JetStream consumer
   * has its own reconnect handling (managed by `NatsBus`), so this is
   * intentionally a no-op — there's no Docker stream to reconnect.
   */
  protected async _connect(): Promise<void> {
    // no-op
  }

  /** Map a Zod-validated EgressGwDecision into the shared ingest pipeline. */
  private async _handleDecision(
    decision: EgressGwDecision,
    ack: () => void,
  ): Promise<void> {
    // The Zod payload schema (`egressGwDecisionSchema`) is a discriminated
    // union over `evt`. Adding a new variant here without extending the
    // schema would silently fall through — we ack and skip rather than
    // hold the message indefinitely.
    if (decision.evt === 'dns.query') {
      await this._ingestDnsQuery(
        {
          ts: decision.ts,
          level: 'info', // schema doesn't carry level; downstream doesn't use it
          evt: 'dns.query',
          srcIp: decision.srcIp,
          qname: decision.qname,
          qtype: decision.qtype,
          action: decision.action,
          matchedPattern: decision.matchedPattern,
          wouldHaveBeen: decision.wouldHaveBeen,
          stackId: decision.stackId,
          serviceName: decision.serviceName,
          reason: decision.reason,
          mergedHits: decision.mergedHits,
        },
        ack,
      );
      return;
    }
    if (decision.evt === 'tcp') {
      if (decision.protocol === 'connect') {
        await this._ingestTcpConnect(
          {
            ts: decision.ts,
            evt: 'tcp',
            protocol: 'connect',
            srcIp: decision.srcIp,
            target: decision.target,
            action: decision.action === 'observed' ? 'allowed' : decision.action,
            reason: decision.reason,
            matchedPattern: decision.matchedPattern,
            stackId: decision.stackId,
            serviceName: decision.serviceName,
            bytesUp: decision.bytesUp,
            bytesDown: decision.bytesDown,
            mergedHits: decision.mergedHits,
          },
          ack,
        );
        return;
      }
      if (decision.protocol === 'http') {
        await this._ingestTcpHttp(
          {
            ts: decision.ts,
            evt: 'tcp',
            protocol: 'http',
            srcIp: decision.srcIp,
            target: decision.target,
            method: decision.method ?? '',
            path: decision.path ?? '',
            action: decision.action === 'observed' ? 'allowed' : decision.action,
            reason: decision.reason,
            matchedPattern: decision.matchedPattern,
            stackId: decision.stackId,
            serviceName: decision.serviceName,
            status: decision.status,
            bytesDown: decision.bytesDown,
            mergedHits: decision.mergedHits,
          },
          ack,
        );
        return;
      }
    }
    log.warn({ evt: (decision as { evt?: string }).evt }, 'Unhandled egress decision evt — acking and skipping');
    ack();
  }
}

// ---------------------------------------------------------------------------
// FwAgentJsConsumer — host singleton, JetStream durable consumer (ALT-27)
// ---------------------------------------------------------------------------
//
// Replaces the legacy `FwAgentTailer` (docker logs follow → NDJSON parse).
// The agent now publishes typed `EgressFwEvent` messages to JetStream via
// `mini-infra.egress.fw.events`; this class reads them through a durable
// consumer named `EgressFwEvents-server`.
//
// The "≤1s loss across agent restart" acceptance criterion is what
// motivated the move: log-attach drops every in-flight line on container
// restart. Durable consumers resume from the last-acked sequence, so an
// agent flap loses only the in-flight (un-acked) batch — typically zero
// or one event.

export class FwAgentJsConsumer extends BaseTailer {
  private cancel: (() => void) | null = null;
  // Re-entrancy guard against the BaseTailer reconnect scheduler firing a
  // second `_connect()` while the first is still mid-await (review M5).
  // Without this, the second call's `consume()` overwrites `this.cancel`
  // with the new iterator's stop, leaking the prior iterator and double-
  // delivering every message it processes.
  private connecting = false;

  constructor(prisma: PrismaClient) {
    super(prisma);
  }

  start(): void {
    void this._connect();
    this._startBatchTimer();
    log.info('Fw-agent JS consumer started');
  }

  stop(): void {
    if (this.cancel) {
      try {
        this.cancel();
      } catch {
        // best-effort
      }
      this.cancel = null;
    }
    super.stop();
    log.info('Fw-agent JS consumer stopped');
  }

  // _connect on BaseTailer is the docker-logs hook; we override to set up
  // the JetStream consumer instead. Same retry-on-reconnect pattern.
  protected async _connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      // Lazy require to avoid the prisma chain at module import time —
      // matches the pattern in fw-agent-transport.ts and fw-agent-sidecar.ts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const busMod = require('../nats/nats-bus') as typeof import('../nats/nats-bus');
      const { EgressFwSubject, NatsStream } = await import('@mini-infra/types');
      const bus = busMod.NatsBus.getInstance();

      // Wait for the bus to be ready. On a cold worktree boot this can
      // take a while; we tolerate it via the same scheduleReconnect path
      // the docker-logs version used.
      await bus.ready({ timeoutMs: 5_000 });

      // The stream is bootstrapped by `nats-system-bootstrap.ts`. The
      // consumer is created here lazily — keeps the consumer name + filter
      // co-located with the code that processes its messages, so a future
      // refactor can grep both with one query.
      await bus.jetstream.ensureConsumer({
        stream: NatsStream.egressFwEvents,
        durable: 'EgressFwEvents-server',
        filterSubject: EgressFwSubject.events,
      });
      this.cancel = bus.jetstream.consume<EgressFwEvent>(
        {
          stream: NatsStream.egressFwEvents,
          durable: 'EgressFwEvents-server',
          filterSubject: EgressFwSubject.events,
        },
        async (msg) => this._handleJsEvent(msg),
        { ack: 'auto' },
      );
      log.info('Fw-agent JS consumer attached to EgressFwEvents stream');
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to attach JS consumer for fw-agent events — will retry',
      );
      this._scheduleReconnect('fw-agent-js');
    } finally {
      this.connecting = false;
    }
  }

  private async _handleJsEvent(evt: EgressFwEvent): Promise<void> {
    // Translate the typed event into the legacy `FwDropLine` shape so the
    // shared dedup/batch path in BaseTailer can ingest it without
    // bifurcating. Mapping is mostly identity:
    //   - occurredAtMs (number) → ts (RFC3339Nano string) for `_ingestFwDrop`
    //   - DestPort (optional) flattened to undefined when missing
    const line: FwDropLine = {
      ts: new Date(evt.occurredAtMs).toISOString(),
      evt: 'fw_drop',
      protocol: evt.protocol,
      srcIp: evt.srcIp,
      destIp: evt.destIp,
      destPort: evt.destPort ?? undefined,
      stackId: evt.stackId,
      serviceName: evt.serviceName,
      reason: evt.reason,
      mergedHits: evt.mergedHits,
    };
    if (!line.stackId) {
      // fw_drop without stackId can't be attributed; matches legacy behavior.
      return;
    }
    await this._ingestFwDrop(line);
  }
}

// ---------------------------------------------------------------------------
// EgressLogIngester — orchestrates the gateway + fw-agent JetStream consumers
// ---------------------------------------------------------------------------
//
// Phase 3 (ALT-28) replaced the gateway's per-env Docker log-attach with a
// single shared JetStream consumer (`EgressDecisionsConsumer`). Phase 2
// (ALT-27) replaced the fw-agent's Docker log-attach with its own JetStream
// consumer (`FwAgentJsConsumer`). Both paths are now bus-driven; no Docker
// container-event listening is needed — durable consumers resume from the
// last-acked sequence on reconnect, regardless of producer-side restarts.
//

export class EgressLogIngester {
  private decisionsConsumer: EgressDecisionsConsumer | null = null;
  private fwAgentConsumer: FwAgentJsConsumer | null = null;
  private stopped = false;

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Start the gateway-decisions consumer and the fw-agent consumer. Both
   * are bus-driven JetStream durable consumers, so neither needs a Docker
   * container-event reconnect loop — the SDK handles resumption.
   */
  async start(): Promise<void> {
    // Single shared JetStream consumer for the gateway. Per-env discrimination
    // is via `environmentId` in the payload, not the subject.
    this.decisionsConsumer = new EgressDecisionsConsumer(this.prisma);
    this.decisionsConsumer.start();

    // Host-singleton fw-agent JetStream consumer (ALT-27). Replaces the
    // legacy Docker log-attach. Durable consumer survives restarts of
    // either the agent or this server.
    this.fwAgentConsumer = new FwAgentJsConsumer(this.prisma);
    this.fwAgentConsumer.start();

    log.info(
      { decisionsConsumer: true, fwAgentConsumer: true },
      'EgressLogIngester started',
    );
  }

  /**
   * Stop both consumers. Idempotent.
   */
  stop(): void {
    this.stopped = true;
    if (this.decisionsConsumer) {
      this.decisionsConsumer.stop();
      this.decisionsConsumer = null;
    }
    if (this.fwAgentConsumer) {
      this.fwAgentConsumer.stop();
      this.fwAgentConsumer = null;
    }
    log.info('EgressLogIngester stopped');
  }
}
