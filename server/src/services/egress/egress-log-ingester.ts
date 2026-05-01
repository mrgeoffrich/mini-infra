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
import type { PrismaClient } from '../../generated/prisma/client';
import DockerService from '../docker';
import { DockerStreamDemuxer } from '../../lib/docker-stream';
import { getLogger } from '../../lib/logger-factory';
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
   */
  protected _checkDedup(
    key: DedupKey,
    mergedHits: number,
    rowFactory: () => PendingRow,
  ): boolean {
    const now = Date.now();
    const bucket = this.dedupBuckets.get(key);

    if (bucket && now - bucket.windowStart < DEDUP_WINDOW_MS) {
      // Within window — accumulate, suppress new row
      bucket.hits += mergedHits;
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

  private async _ingestDnsQuery(line: DnsQueryLine): Promise<void> {
    if (!line.stackId) return;

    const policyContext = await this._lookupPolicy(line.stackId);
    if (!policyContext) {
      this._warnNoPolicyIfNeeded(line.stackId, 'dns.query', line.srcIp);
      return;
    }

    const key = makeDedupKey(policyContext.id, line.serviceName, line.qname, line.action);
    const suppressed = this._checkDedup(key, line.mergedHits, () => ({
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
    }));

    if (!suppressed && line.matchedPattern) {
      void this._bumpRuleHits(policyContext.id, line.matchedPattern);
    }
  }

  private async _ingestTcpConnect(line: TcpConnectLine): Promise<void> {
    if (!line.stackId) return;

    const policyContext = await this._lookupPolicy(line.stackId);
    if (!policyContext) {
      this._warnNoPolicyIfNeeded(line.stackId, 'tcp/connect', line.srcIp);
      return;
    }

    const key = makeDedupKey(policyContext.id, line.serviceName, line.target, line.action);
    const suppressed = this._checkDedup(key, line.mergedHits, () => ({
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
    }));

    if (!suppressed && line.matchedPattern) {
      void this._bumpRuleHits(policyContext.id, line.matchedPattern);
    }
  }

  private async _ingestTcpHttp(line: TcpHttpLine): Promise<void> {
    if (!line.stackId) return;

    const policyContext = await this._lookupPolicy(line.stackId);
    if (!policyContext) {
      this._warnNoPolicyIfNeeded(line.stackId, 'tcp/http', line.srcIp);
      return;
    }

    const key = makeDedupKey(policyContext.id, line.serviceName, line.target, line.action);
    const suppressed = this._checkDedup(key, line.mergedHits, () => ({
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
    }));

    if (!suppressed && line.matchedPattern) {
      void this._bumpRuleHits(policyContext.id, line.matchedPattern);
    }
  }

  protected async _ingestFwDrop(line: FwDropLine): Promise<void> {
    if (!line.stackId) {
      // fw_drop without stackId cannot be attributed — drop it
      return;
    }

    const policyContext = await this._lookupPolicy(line.stackId);
    if (!policyContext) {
      this._warnNoPolicyIfNeeded(line.stackId, 'fw_drop', line.srcIp);
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
    const suppressed = this._checkDedup(key, line.mergedHits, () => ({
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
    }));
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

  private _rollExpiredDedupWindows(): void {
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
// GatewayTailer — one per environment
// ---------------------------------------------------------------------------

class GatewayTailer extends BaseTailer {
  constructor(
    private readonly envId: string,
    private readonly envName: string,
    prisma: PrismaClient,
  ) {
    super(prisma);
  }

  start(): void {
    void this._connect();
    this._startBatchTimer();
    log.info({ envId: this.envId, envName: this.envName }, 'Gateway tailer started');
  }

  stop(): void {
    super.stop();
    log.info({ envId: this.envId, envName: this.envName }, 'Gateway tailer stopped');
  }

  protected async _connect(): Promise<void> {
    if (this.stopped) return;

    const containerName = `${this.envName}-egress-gateway-egress-gateway`;

    const dockerService = DockerService.getInstance();
    if (!dockerService.isConnected()) {
      log.warn({ containerName }, 'Docker not connected — will retry');
      this._scheduleReconnect(containerName);
      return;
    }

    try {
      const docker = await dockerService.getDockerInstance();

      const containers = await docker.listContainers({
        all: false,
        filters: JSON.stringify({ name: [containerName] }),
      });
      const match = containers.find((c) =>
        c.Names?.some((n) => n === `/${containerName}`),
      );

      if (!match) {
        log.debug({ containerName }, 'Gateway container not found — will retry');
        this._scheduleReconnect(containerName);
        return;
      }

      const dockerContainer = docker.getContainer(match.Id);
      const rawStream = (await dockerContainer.logs({
        follow: true as const,
        stdout: true,
        stderr: false,
        tail: 0,
      })) as unknown as Readable;

      this._attachStream(rawStream, containerName);
      log.info({ containerName, containerId: match.Id }, 'Tailing gateway container logs');
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), containerName },
        'Failed to attach to gateway log stream — reconnecting',
      );
      this._scheduleReconnect(containerName);
    }
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
// EgressLogIngester — orchestrates GatewayTailers + FwAgentJsConsumer
// ---------------------------------------------------------------------------

interface EnvRow {
  id: string;
  name: string;
  egressGatewayIp: string;
}

export class EgressLogIngester {
  private readonly tailers = new Map<string, GatewayTailer>();
  private fwAgentConsumer: FwAgentJsConsumer | null = null;
  private stopped = false;

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Start tailing all currently known gateway environments and the fw-agent
   * singleton, and subscribe to Docker events so we reconnect when containers
   * restart.
   */
  async start(): Promise<void> {
    // Initial scan — per-env gateway tailers
    const envs = await this._getEnvsWithGateway();
    for (const env of envs) {
      this._ensureTailer(env);
    }

    // Host-singleton fw-agent JS consumer (ALT-27 — replaces the legacy
    // docker-logs follow). Durable consumer survives restarts of either the
    // agent or this server, so we don't need to react to docker container
    // events for the fw-agent anymore — JetStream handles the resumption.
    this.fwAgentConsumer = new FwAgentJsConsumer(this.prisma);
    this.fwAgentConsumer.start();

    // Subscribe to Docker container events for the gateway tailers only.
    // (The fw-agent doesn't need a docker-event listener — see comment
    // above.)
    const dockerService = DockerService.getInstance();
    dockerService.onContainerEvent((event) => {
      if (this.stopped) return;

      const name = event.containerName ?? '';

      // Gateway containers — name-based match
      if (name.endsWith('-egress-gateway-egress-gateway')) {
        if (event.action === 'start' || event.action === 'die' || event.action === 'stop') {
          void this._reconcileTailers();
        }
      }
    });

    log.info(
      { tailerCount: this.tailers.size, fwAgentConsumer: true },
      'EgressLogIngester started',
    );
  }

  /**
   * Stop all tailers.
   */
  stop(): void {
    this.stopped = true;
    for (const tailer of this.tailers.values()) {
      tailer.stop();
    }
    this.tailers.clear();
    if (this.fwAgentConsumer) {
      this.fwAgentConsumer.stop();
      this.fwAgentConsumer = null;
    }
    log.info('EgressLogIngester stopped');
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _ensureTailer(env: EnvRow): void {
    if (this.tailers.has(env.id)) return;
    const tailer = new GatewayTailer(env.id, env.name, this.prisma);
    this.tailers.set(env.id, tailer);
    tailer.start();
  }

  private async _reconcileTailers(): Promise<void> {
    const envs = await this._getEnvsWithGateway();
    const envIds = new Set(envs.map((e) => e.id));

    // Start new tailers
    for (const env of envs) {
      this._ensureTailer(env);
    }

    // Stop tailers for environments that no longer have a gateway
    for (const [envId, tailer] of this.tailers.entries()) {
      if (!envIds.has(envId)) {
        tailer.stop();
        this.tailers.delete(envId);
      }
    }
  }

  private async _getEnvsWithGateway(): Promise<EnvRow[]> {
    const envs = await this.prisma.environment.findMany({
      where: { egressGatewayIp: { not: null } },
      select: { id: true, name: true, egressGatewayIp: true },
    });
    return envs.filter(
      (e): e is EnvRow => e.egressGatewayIp !== null && e.egressGatewayIp !== undefined,
    );
  }
}
