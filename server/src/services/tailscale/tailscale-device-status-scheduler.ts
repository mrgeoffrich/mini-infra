import {
  Channel,
  ServerEvent,
  type TailscaleDeviceStatus,
} from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import { withOperation } from "../../lib/logging-context";
import { emitToChannel } from "../../lib/socket";
import { TailscaleService } from "./tailscale-service";

const DEFAULT_INTERVAL_MS = 30_000;
const logger = getLogger("integrations", "tailscale-device-status-scheduler");

interface SchedulerSnapshot {
  /** Most recent device map, keyed by hostname (the join key the panel uses). */
  devicesByHostname: Map<string, TailscaleDeviceStatus>;
  /** Tailnet MagicDNS suffix; null until the first successful resolution. */
  tailnet: string | null;
  /** Wall-clock of the most recent successful tick, ISO-8601. */
  lastUpdatedAt: string | null;
}

/**
 * Polls Tailscale's device-list API on a fixed interval, compares the
 * result against the previous tick, and emits per-device transition events
 * onto the `tailscale` Socket.IO channel. Maintains an in-process snapshot
 * the `GET /api/tailscale/devices` route reads — no DB persistence; live
 * tailnet state is the source of truth and the snapshot is the cache.
 *
 * Emit semantics:
 * - first time a device is seen: emit `TAILSCALE_DEVICE_ONLINE` if online,
 *   `TAILSCALE_DEVICE_OFFLINE` otherwise. The Connect panel needs an
 *   initial event per device so its TanStack Query cache picks up the
 *   right status without forcing a re-fetch.
 * - subsequent ticks emit only on transition (online ↔ offline).
 *
 * The scheduler is best-effort — a failed tick logs and skips, leaving the
 * previous snapshot intact. The badges in the UI fall back to the cached
 * status; that's the intended degraded state, not a panic condition.
 */
export class TailscaleDeviceStatusScheduler {
  private readonly tailscale: TailscaleService;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private snapshot: SchedulerSnapshot = {
    devicesByHostname: new Map(),
    tailnet: null,
    lastUpdatedAt: null,
  };

  private static instance: TailscaleDeviceStatusScheduler | null = null;

  static getInstance(): TailscaleDeviceStatusScheduler | null {
    return TailscaleDeviceStatusScheduler.instance;
  }

  static setInstance(instance: TailscaleDeviceStatusScheduler | null): void {
    TailscaleDeviceStatusScheduler.instance = instance;
  }

  constructor(
    tailscale: TailscaleService,
    options: { intervalMs?: number } = {},
  ) {
    this.tailscale = tailscale;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  async start(): Promise<void> {
    if (this.timer) {
      logger.warn(
        "Tailscale device-status scheduler already running, restarting",
      );
      this.stop();
    }
    logger.info(
      { intervalMs: this.intervalMs },
      "Starting Tailscale device-status scheduler",
    );

    // Run an initial tick immediately so the first request to the GET route
    // returns a populated snapshot rather than an empty list.
    await this.runOnce();

    this.timer = setInterval(() => {
      void withOperation("tailscale-device-status-tick", () => this.runOnce());
    }, this.intervalMs);
    // Don't keep the event loop alive on shutdown — the explicit stop()
    // path runs on SIGTERM.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Tailscale device-status scheduler stopped");
    }
  }

  /**
   * Read the most recent successful snapshot. Returns the live in-process
   * map — callers should not mutate it.
   */
  getSnapshot(): SchedulerSnapshot {
    return this.snapshot;
  }

  private async runOnce(): Promise<void> {
    const startedAt = Date.now();

    let devices: TailscaleDeviceStatus[];
    try {
      devices = await this.tailscale.listDevices();
    } catch (err) {
      logger.warn(
        { err, durationMs: Date.now() - startedAt },
        "Tailscale device-list poll failed (non-fatal)",
      );
      return;
    }

    // Tailnet domain is needed by the Connect panel for URL formatting.
    // Best-effort — if the lookup fails we keep the previous value.
    let tailnet = this.snapshot.tailnet;
    try {
      const resolved = await this.tailscale.getTailnetDomain();
      if (resolved) tailnet = resolved;
    } catch (err) {
      logger.debug(
        { err },
        "Tailnet domain lookup failed (non-fatal, reusing cached value)",
      );
    }

    const previous = this.snapshot.devicesByHostname;
    const next = new Map<string, TailscaleDeviceStatus>();
    for (const device of devices) {
      next.set(device.hostname, device);
      const wasKnown = previous.get(device.hostname);
      const transitioned =
        !wasKnown || wasKnown.online !== device.online;
      if (transitioned) {
        const event = device.online
          ? ServerEvent.TAILSCALE_DEVICE_ONLINE
          : ServerEvent.TAILSCALE_DEVICE_OFFLINE;
        try {
          emitToChannel(Channel.TAILSCALE, event, { device });
        } catch (err) {
          logger.warn(
            { err, hostname: device.hostname },
            "Failed to emit tailscale device-status event (non-fatal)",
          );
        }
      }
    }

    // Devices that disappeared between ticks — likely deregistered (ephemeral
    // node). Emit one final OFFLINE so any UI listener can clear its row.
    for (const [hostname, prev] of previous.entries()) {
      if (!next.has(hostname) && prev.online) {
        try {
          emitToChannel(Channel.TAILSCALE, ServerEvent.TAILSCALE_DEVICE_OFFLINE, {
            device: { ...prev, online: false },
          });
        } catch (err) {
          logger.warn(
            { err, hostname },
            "Failed to emit deregistration OFFLINE (non-fatal)",
          );
        }
      }
    }

    this.snapshot = {
      devicesByHostname: next,
      tailnet,
      lastUpdatedAt: new Date().toISOString(),
    };

    logger.debug(
      {
        deviceCount: next.size,
        tailnet,
        durationMs: Date.now() - startedAt,
      },
      "Tailscale device-status tick completed",
    );
  }
}
