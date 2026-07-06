import { Router } from "express";
import { asyncHandler } from "../lib/async-handler";
import { requirePermission } from "../middleware/auth";
import {
  TailscaleDeviceStatusScheduler,
} from "../services/tailscale";
import type {
  TailscaleDevicesResponse,
} from "@mini-infra/types";
import { Permission } from "@mini-infra/types";

const router = Router();

/**
 * GET /api/tailscale/devices
 *
 * Returns the in-process device-status snapshot maintained by the scheduler.
 * The snapshot refreshes on the scheduler's poll interval (default 30s); the
 * Connect panel relies on Socket.IO `tailscale:device:online` /
 * `tailscale:device:offline` events for sub-poll latency, this route is for
 * the initial query + reconnect re-fetch.
 *
 * Returns an empty payload when the scheduler is not yet running (Tailscale
 * not configured) — the panel renders the empty state in that case rather
 * than 404'ing.
 */
router.get(
  "/devices",
  requirePermission(Permission.SettingsRead),
  asyncHandler(async (_req, res) => {
    const scheduler = TailscaleDeviceStatusScheduler.getInstance();
    if (!scheduler) {
      const empty: TailscaleDevicesResponse = {
        tailnet: null,
        devices: [],
        lastUpdatedAt: null,
      };
      return res.json(empty);
    }

    const snapshot = scheduler.getSnapshot();
    const response: TailscaleDevicesResponse = {
      tailnet: snapshot.tailnet,
      devices: Array.from(snapshot.devicesByHostname.values()),
      lastUpdatedAt: snapshot.lastUpdatedAt,
    };
    res.json(response);
  }),
);

export default router;
