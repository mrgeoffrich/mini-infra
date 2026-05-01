/**
 * NatsBus — the singleton chokepoint for system-internal NATS messaging.
 *
 * One NATS connection per server process. All publish/request/subscribe goes
 * through here so we get one set of guarantees instead of N: typed payloads,
 * Zod validation on both ends, structured logging with subject correlation,
 * a non-blocking reconnect loop, and a single shutdown path.
 *
 * Subjects are constants in `lib/types/nats-subjects.ts`. Schemas live in
 * `./payload-schemas.ts`. **No raw subject strings or raw `nats.connect()`
 * elsewhere in `server/src`** — see the rules in
 * `docs/planning/not-shipped/internal-nats-messaging-plan.md` §5.
 *
 * Boot ordering (server/src/server.ts): `NatsBus.getInstance().start()` is
 * fire-and-forget and returns immediately. The reconnect loop runs forever
 * in the background, so a fresh worktree where `vault-nats` hasn't booted
 * yet doesn't stall the parent process. Callers that genuinely need a
 * connection use `await bus.ready({ timeoutMs })`.
 */

import { connect, credsAuthenticator, type NatsConnection, type Subscription } from "nats";
import { z, type ZodType } from "zod";
import { getLogger } from "../../lib/logger-factory";
import { getVaultKVService } from "../vault/vault-kv-service";
import {
  FIELD_SERVER_BUS_CREDS,
  NATS_SERVER_BUS_CREDS_KV_PATH,
  getNatsControlPlaneService,
} from "./nats-control-plane-service";
import { payloadSchemas, type SubjectSchemaEntry } from "./payload-schemas";

const log = getLogger("integrations", "nats-bus");
const RECONNECT_BACKOFF_MIN_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export type BusState = "disconnected" | "connecting" | "connected" | "shutting-down";

export interface BusHealth {
  state: BusState;
  /** Wall-clock time (ms since epoch) of the last successful connect. */
  lastConnectedAtMs: number | null;
  /** Last connection error message, cleared on successful connect. */
  lastErrorMessage: string | null;
  /** Server-reported URL the bus is connected to (or attempting). */
  url: string | null;
}

export interface PublishOptions {
  /**
   * Skip Zod validation for this call. Use sparingly — only when the subject
   * carries an opaque blob (e.g. NFLOG events) or routes through a wildcard
   * for which no static schema is registered.
   */
  unchecked?: boolean;
}

export interface RequestOptions extends PublishOptions {
  /** Request timeout in milliseconds. Defaults to 5 000. */
  timeoutMs?: number;
}

export interface SubscribeOptions {
  unchecked?: boolean;
  /** Optional queue group for load-balanced delivery. */
  queue?: string;
}

export type SubscribeHandler<T> = (
  msg: T,
  ctx: SubscribeContext,
) => Promise<unknown> | unknown;

export interface SubscribeContext {
  /** The subject the message arrived on (may differ from subscription on wildcard subs). */
  subject: string;
  /** Reply subject when the message is a request, otherwise undefined. */
  reply: string | undefined;
}

export interface NatsBusOptions {
  /**
   * Override the URL/credential resolution path. Used by integration tests
   * to point at an ephemeral NATS container without going through Vault KV.
   */
  testOverride?: {
    url: string;
    creds?: string;
  };
}

interface SubscriptionRegistration {
  subject: string;
  handler: SubscribeHandler<unknown>;
  opts: SubscribeOptions;
  /** Set to the live `Subscription` while the bus is connected; null otherwise. */
  live: Subscription | null;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export class NatsBus {
  private static _instance: NatsBus | null = null;

  static getInstance(opts?: NatsBusOptions): NatsBus {
    if (!NatsBus._instance) {
      NatsBus._instance = new NatsBus(opts);
    }
    return NatsBus._instance;
  }

  /** Reset the singleton — for tests only. */
  static resetInstanceForTests(): void {
    NatsBus._instance = null;
  }

  private state: BusState = "disconnected";
  private nc: NatsConnection | null = null;
  private connectAttempt = 0;
  private lastConnectedAtMs: number | null = null;
  private lastErrorMessage: string | null = null;
  private currentUrl: string | null = null;
  private readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  // Active subscriptions on the current connection. Replaced on reconnect.
  private liveSubs: Subscription[] = [];
  // Durable subscriber registrations. Re-attached after every reconnect so a
  // caller can `bus.subscribe(...)` once at boot and keep receiving messages
  // across NATS bounces without bookkeeping.
  private registrations: SubscriptionRegistration[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private started = false;
  // Guard against overlapping connect attempts — `invalidateCreds` can fire
  // while `attemptConnect` is mid-await, and without this two parallel
  // `connect()` calls would race to write `this.nc`. The guard is set true
  // when `attemptConnect` enters and cleared when it returns (success or
  // failure). The reconnect scheduler skips queueing while `connecting` is
  // true; once the in-flight attempt finishes it always reschedules itself.
  private connecting = false;
  // Track every in-flight handler Promise so `shutdown()` can wait for them
  // to settle before draining the connection — prevents post-shutdown side
  // effects in stateful Phase 2+ handlers.
  private activeHandlers = new Set<Promise<unknown>>();

  private constructor(private readonly opts: NatsBusOptions = {}) {}

  /**
   * Kick off the connect loop. Returns immediately — connection happens in
   * the background. Safe to call repeatedly; subsequent calls are a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleReconnect(0);
  }

  /**
   * Drain the connection and stop the reconnect loop. Idempotent.
   *
   * Stops accepting new work, then unsubscribes live subscriptions (which
   * causes their `consume` loops to exit), waits for any in-flight handler
   * Promises to settle, and finally drains the connection. Handlers that
   * started before shutdown finish their work before the bus closes —
   * critical for any future stateful consumer.
   */
  async shutdown(): Promise<void> {
    if (this.state === "shutting-down" || this.state === "disconnected") return;
    this.state = "shutting-down";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectReadyWaiters(new Error("NatsBus shutting down"));

    // Stop subscription iterators so consume() loops fall through. We do
    // this before draining so handlers that are blocked on `for await msg`
    // don't see another message arriving during shutdown.
    for (const sub of this.liveSubs) {
      try {
        sub.unsubscribe();
      } catch {
        // best-effort
      }
    }
    this.liveSubs = [];
    for (const reg of this.registrations) reg.live = null;

    // Wait for in-flight handlers to settle. allSettled so a misbehaving
    // handler can't block the rest of shutdown forever.
    if (this.activeHandlers.size > 0) {
      await Promise.allSettled([...this.activeHandlers]);
    }

    const nc = this.nc;
    this.nc = null;
    if (nc) {
      try {
        await nc.drain();
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "drain on shutdown failed",
        );
      }
    }
    this.state = "disconnected";
  }

  /**
   * Block until the bus is connected, or reject after `timeoutMs`.
   * Resolves immediately if already connected.
   */
  ready(opts: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.state === "shutting-down") {
      return Promise.reject(new Error("NatsBus shutting down"));
    }
    const timeoutMs = opts.timeoutMs ?? 10_000;
    return new Promise<void>((resolve, reject) => {
      const handle = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w.resolve !== onResolve);
        reject(new Error(`NatsBus.ready timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onResolve = () => {
        clearTimeout(handle);
        resolve();
      };
      const onReject = (err: Error) => {
        clearTimeout(handle);
        reject(err);
      };
      this.readyWaiters.push({ resolve: onResolve, reject: onReject });
    });
  }

  getHealth(): BusHealth {
    return {
      state: this.state,
      lastConnectedAtMs: this.lastConnectedAtMs,
      lastErrorMessage: this.lastErrorMessage,
      url: this.currentUrl,
    };
  }

  /**
   * Mark the cached credential as stale and force a reconnect. Called by
   * `NatsControlPlaneService.applyConfig()` after rotating the bus creds
   * blob in Vault KV.
   *
   * Safe to call before `start()`: in that case the bus has nothing to
   * disconnect, but the next call to `start()` will re-read creds from
   * Vault (which is what every cold connect does anyway), so the invalidate
   * is implicitly satisfied without any extra state. Logged at info either
   * way so the call is visible in the boot transcript.
   */
  invalidateCreds(): void {
    if (!this.started) {
      log.info("creds invalidated before bus start; first connect will pick up fresh creds");
      return;
    }
    log.info("creds invalidated, scheduling reconnect");
    const nc = this.nc;
    this.nc = null;
    this.state = "connecting";
    if (nc) {
      // Best-effort drain; don't await so callers never block.
      nc.drain().catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "drain after creds invalidation failed",
        );
      });
    }
    this.scheduleReconnect(0);
  }

  // ============================================================
  // Publish / request / subscribe
  // ============================================================

  async publish<T>(subject: string, payload: T, opts: PublishOptions = {}): Promise<void> {
    const nc = this.requireConnected();
    const validated = opts.unchecked ? payload : this.validateRequest(subject, payload);
    nc.publish(subject, ENCODER.encode(JSON.stringify(validated)));
  }

  async request<Req, Res>(
    subject: string,
    payload: Req,
    opts: RequestOptions = {},
  ): Promise<Res> {
    const nc = this.requireConnected();
    const validated = opts.unchecked ? payload : this.validateRequest(subject, payload);
    const reply = await nc.request(
      subject,
      ENCODER.encode(JSON.stringify(validated)),
      { timeout: opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
    );
    const body = this.decodeBody<unknown>(reply.data);
    return (opts.unchecked ? body : this.validateReply(subject, body)) as Res;
  }

  /**
   * Subscribe to a subject. The handler runs once per message; errors are
   * caught and logged so a misbehaving handler can't tear down the
   * subscription. For wildcard subjects, pass `unchecked: true` and validate
   * inside the handler.
   *
   * **Durable across reconnects.** The registration is remembered and the
   * subscription is re-attached every time the bus reconnects to NATS, so
   * callers register once at boot and don't have to re-register after
   * `invalidateCreds()` or transient disconnects.
   *
   * Returns a cancel handle, not the underlying `Subscription`. Call it to
   * permanently unregister (it removes from the durable list and unsubs the
   * current live subscription if any).
   */
  subscribe<T>(
    subject: string,
    handler: SubscribeHandler<T>,
    opts: SubscribeOptions = {},
  ): () => void {
    const reg: SubscriptionRegistration = {
      subject,
      handler: handler as SubscribeHandler<unknown>,
      opts,
      live: null,
    };
    this.registrations.push(reg);
    if (this.state === "connected" && this.nc) {
      this.attachRegistration(reg, this.nc);
    }
    return () => {
      this.registrations = this.registrations.filter((r) => r !== reg);
      if (reg.live) {
        try {
          reg.live.unsubscribe();
        } catch {
          // best-effort
        }
      }
    };
  }

  /**
   * Subscribe to a request/reply subject. The handler returns the reply
   * payload (validated against the subject's reply schema) which the bus
   * sends back on `msg.reply`.
   *
   * Durable across reconnects (see `subscribe`).
   */
  respond<Req, Res>(
    subject: string,
    handler: (req: Req, ctx: SubscribeContext) => Promise<Res> | Res,
    opts: SubscribeOptions = {},
  ): () => void {
    return this.subscribe<Req>(
      subject,
      async (msg, ctx) => {
        const result = await handler(msg, ctx);
        if (!ctx.reply) {
          log.warn({ subject: ctx.subject }, "respond handler called on non-request message");
          return;
        }
        const validated = opts.unchecked ? result : this.validateReply(subject, result);
        const nc = this.requireConnected();
        nc.publish(ctx.reply, ENCODER.encode(JSON.stringify(validated)));
      },
      opts,
    );
  }

  private attachRegistration(reg: SubscriptionRegistration, nc: NatsConnection): void {
    const sub = nc.subscribe(
      reg.subject,
      reg.opts.queue ? { queue: reg.opts.queue } : undefined,
    );
    reg.live = sub;
    this.liveSubs.push(sub);
    void this.consume(reg.subject, sub, reg.handler, reg.opts);
  }

  private reattachAllRegistrations(nc: NatsConnection): void {
    // Tear down old subs first. The async iterator inside each `consume()`
    // loop terminates when its `Subscription` is unsubscribed, so calling
    // unsubscribe here lets the old loop exit cleanly *before* a new one
    // is started for the same registration. Without this, a brief window
    // exists during which an old handler could process a stray message
    // delivered by the dying connection's drain alongside the new sub —
    // benign for the ping responder, a double-processing bug for any
    // stateful Phase 2+ consumer.
    for (const oldSub of this.liveSubs) {
      try {
        oldSub.unsubscribe();
      } catch {
        // best-effort
      }
    }
    this.liveSubs = [];
    for (const reg of this.registrations) {
      reg.live = null;
      this.attachRegistration(reg, nc);
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private requireConnected(): NatsConnection {
    if (this.state !== "connected" || !this.nc) {
      throw new Error(`NatsBus not connected (state=${this.state})`);
    }
    return this.nc;
  }

  private decodeBody<T>(buf: Uint8Array): T {
    if (buf.length === 0) return undefined as unknown as T;
    return JSON.parse(DECODER.decode(buf)) as T;
  }

  private getSchemaEntry(subject: string): SubjectSchemaEntry | undefined {
    return payloadSchemas[subject];
  }

  private validateRequest(subject: string, payload: unknown): unknown {
    const entry = this.getSchemaEntry(subject);
    if (!entry) return payload;
    return validateOrThrow(entry.request, subject, "request", payload);
  }

  private validateReply(subject: string, payload: unknown): unknown {
    const entry = this.getSchemaEntry(subject);
    if (!entry?.reply) return payload;
    return validateOrThrow(entry.reply, subject, "reply", payload);
  }

  private async consume<T>(
    subject: string,
    sub: Subscription,
    handler: SubscribeHandler<T>,
    opts: SubscribeOptions,
  ): Promise<void> {
    for await (const msg of sub) {
      const ctx: SubscribeContext = { subject: msg.subject, reply: msg.reply };
      const work = (async () => {
        try {
          const raw = this.decodeBody<unknown>(msg.data);
          const body = opts.unchecked ? raw : this.validateRequest(subject, raw);
          await handler(body as T, ctx);
        } catch (err) {
          log.error(
            {
              subject,
              arrivedOn: msg.subject,
              err: err instanceof Error ? err.message : String(err),
            },
            "nats subscriber handler failed",
          );
        }
      })();
      // Track the in-flight Promise so shutdown() can wait for it. We
      // remove on settle (regardless of outcome) so the Set never leaks.
      this.activeHandlers.add(work);
      void work.finally(() => this.activeHandlers.delete(work));
      // Serialise per-subscription so a slow handler doesn't pile up
      // unbounded message work — a single handler-instance-at-a-time per
      // subscription matches typical req/reply expectations and keeps
      // shutdown's wait set bounded by sub-count rather than message-rate.
      await work;
    }
  }

  // ============================================================
  // Reconnect loop
  // ============================================================

  private scheduleReconnect(delayMs: number): void {
    if (this.state === "shutting-down") return;
    // Don't stack timers. If a connect is already in flight or queued, the
    // running attempt will reschedule itself on completion.
    if (this.connecting || this.reconnectTimer) return;
    this.state = "connecting";
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptConnect();
    }, delayMs);
  }

  private async attemptConnect(): Promise<void> {
    if (this.state === "shutting-down") return;
    // Re-entrancy guard. `invalidateCreds` can call `scheduleReconnect(0)`
    // while a previous attempt is still mid-await (waiting on `connect()`
    // or `resolveConnection()`); without this guard two `connect()` calls
    // would race to write `this.nc` and we'd orphan the loser's connection.
    if (this.connecting) return;
    this.connecting = true;
    this.connectAttempt += 1;
    let url: string | null = null;
    let creds: string | undefined;
    try {
      const resolved = await this.resolveConnection();
      url = resolved.url;
      creds = resolved.creds;
      this.currentUrl = url;
      const nc = await connect({
        servers: url,
        ...(creds
          ? { authenticator: credsAuthenticator(ENCODER.encode(creds)) }
          : {}),
        timeout: 5_000,
        // The SDK's own reconnect handles transient drops once we're up.
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: RECONNECT_BACKOFF_MIN_MS,
      });
      this.onConnected(nc, url);
      this.connecting = false;
      // Wait for the connection to close, then schedule a fresh attempt.
      void nc
        .closed()
        .then((err) => {
          this.onDisconnected(err ?? null);
        })
        .catch((err) => {
          this.onDisconnected(err instanceof Error ? err : new Error(String(err)));
        });
    } catch (err) {
      this.lastErrorMessage = err instanceof Error ? err.message : String(err);
      const delay = backoffDelayMs(this.connectAttempt);
      log.warn(
        {
          url,
          attempt: this.connectAttempt,
          delayMs: delay,
          err: this.lastErrorMessage,
        },
        "nats bus connect failed; will retry",
      );
      this.connecting = false;
      this.scheduleReconnect(delay);
    }
  }

  private async resolveConnection(): Promise<{ url: string; creds?: string }> {
    if (this.opts.testOverride) {
      return {
        url: this.opts.testOverride.url,
        creds: this.opts.testOverride.creds,
      };
    }
    const url = await getNatsControlPlaneService().getInternalUrl();
    let creds: string | undefined;
    let readError: string | null = null;
    try {
      const kv = getVaultKVService();
      const blob = await kv.read(NATS_SERVER_BUS_CREDS_KV_PATH);
      const v = blob?.[FIELD_SERVER_BUS_CREDS];
      if (typeof v === "string" && v.length > 0) creds = v;
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
    if (!creds) {
      // Surface the actual cause (Vault sealed, no admin token, path 404,
      // wrong field) instead of the boot-time-friendly fallback message.
      // Without this you can't tell apart "applyConfig hasn't run yet" from
      // "applyConfig wrote the blob but Vault auth has rotated underneath us".
      throw new Error(
        `server bus creds not usable at ${NATS_SERVER_BUS_CREDS_KV_PATH}: ` +
          (readError ?? "KV read returned null or missing field"),
      );
    }
    return { url, creds };
  }

  private onConnected(nc: NatsConnection, url: string): void {
    this.nc = nc;
    this.state = "connected";
    this.connectAttempt = 0;
    this.lastConnectedAtMs = Date.now();
    this.lastErrorMessage = null;
    this.currentUrl = url;
    log.info({ url, registrations: this.registrations.length }, "nats bus connected");
    this.reattachAllRegistrations(nc);
    this.resolveReadyWaiters();
  }

  private onDisconnected(err: Error | null): void {
    if (this.state === "shutting-down") return;
    this.nc = null;
    this.lastErrorMessage = err?.message ?? null;
    log.warn(
      { err: err?.message ?? null },
      "nats bus connection closed; reconnecting",
    );
    this.scheduleReconnect(backoffDelayMs(1));
  }

  private resolveReadyWaiters(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.resolve();
  }

  private rejectReadyWaiters(err: Error): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(err);
  }
}

function backoffDelayMs(attempt: number): number {
  const base = Math.min(
    RECONNECT_BACKOFF_MAX_MS,
    RECONNECT_BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1),
  );
  // Full jitter — caps thundering herd if multiple processes restart at once.
  return Math.floor(Math.random() * base);
}

function validateOrThrow<T>(
  schema: ZodType<T>,
  subject: string,
  kind: "request" | "reply",
  payload: unknown,
): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i: z.ZodIssue) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`nats payload validation failed [${subject} ${kind}]: ${issues}`);
  }
  return result.data;
}
