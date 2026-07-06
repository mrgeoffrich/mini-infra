/**
 * Out-of-band egress agent health scraper (Phase 3, §4.2).
 *
 * The egress agents report functional health *in-band* over a NATS KV
 * heartbeat — but when NATS *auth* is what's broken, the agent can't publish
 * the heartbeat, so "auth-failing" looks identical to "still starting". That's
 * the gap that let a production incident sit silent for ~15 hours.
 *
 * Each agent additionally exposes its NATS connection state over a local HTTP
 * `GET /healthz` (served by the shared `natsbus.ServeHealth`, independent of the
 * NATS link). This module scrapes that endpoint and resolves how to reach each
 * agent:
 *
 *   - fw-agent runs `network_mode: host`, so it binds a known TCP port on the
 *     docker host. The server (a bridge container) reaches the host via its own
 *     network's gateway IP. `EGRESS_FW_AGENT_HEALTH_URL` overrides the derivation.
 *   - each gateway shares the `nats` docker network with the server, so it's
 *     reachable on its container IP on that shared network.
 *
 * Everything here is best-effort: any failure resolves to `null` so the scrape
 * never throws into the caller (the health watcher / a pusher's emit path).
 */

import { getLogger } from "../../lib/logger-factory";
import DockerService from "../docker";
import { getOwnContainerId } from "../self-update";
import type { EgressAgentConnState, EgressAgentHealthReport } from "@mini-infra/types";

const log = getLogger("integrations", "agent-health-scraper");

/** TCP port the host-network fw-agent binds `/healthz` on (matches the Go default). */
export const FW_AGENT_HEALTH_PORT = 9750;
/** TCP port the gateway binds `/healthz` on inside its container namespace. */
export const GATEWAY_HEALTH_PORT = 9751;

const DEFAULT_SCRAPE_TIMEOUT_MS = 2_000;

const VALID_STATES: ReadonlySet<string> = new Set<EgressAgentConnState>([
  "connected",
  "reconnecting",
  "auth-failed",
  "disconnected",
]);

function isConnState(v: unknown): v is EgressAgentConnState {
  return typeof v === "string" && VALID_STATES.has(v);
}

/**
 * Scrape `GET <baseUrl>/healthz` and return the parsed report, or `null` on any
 * failure (unreachable, timeout, non-2xx, malformed body). Never throws.
 *
 * `baseUrl` is a scheme+host+port with no trailing `/healthz` (e.g.
 * `http://172.20.0.4:9751`).
 */
export async function scrapeAgentHealth(
  baseUrl: string,
  timeoutMs: number = DEFAULT_SCRAPE_TIMEOUT_MS,
): Promise<EgressAgentHealthReport | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/healthz`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      log.debug({ url, status: res.status }, "agent /healthz non-2xx");
      return null;
    }
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const rec = body as Record<string, unknown>;
    if (!isConnState(rec.status)) {
      log.debug({ url, status: rec.status }, "agent /healthz unknown status value");
      return null;
    }
    const age =
      typeof rec.lastHeartbeatAgeMs === "number" && Number.isFinite(rec.lastHeartbeatAgeMs)
        ? rec.lastHeartbeatAgeMs
        : -1;
    return { status: rec.status, lastHeartbeatAgeMs: age };
  } catch (err) {
    log.debug(
      { url, err: err instanceof Error ? err.message : String(err) },
      "agent /healthz scrape failed",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Reachability resolution
// ---------------------------------------------------------------------------

let cachedHostGatewayIp: string | null = null;

/**
 * The docker-host gateway IP as seen from the server's own container — i.e. the
 * address that routes to host-bound ports (where the `network_mode: host`
 * fw-agent listens). Cached: the bridge gateway is stable for the container's
 * lifetime. Returns `null` when not running in Docker or inspection fails.
 */
async function resolveHostGatewayIp(): Promise<string | null> {
  if (cachedHostGatewayIp) return cachedHostGatewayIp;
  const ownId = getOwnContainerId();
  if (!ownId) return null;
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const info = await docker.getContainer(ownId).inspect();
    const nets = info.NetworkSettings?.Networks ?? {};
    for (const net of Object.values(nets)) {
      const gw = (net as { Gateway?: string })?.Gateway;
      if (gw && gw.length > 0) {
        cachedHostGatewayIp = gw;
        return gw;
      }
    }
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "resolveHostGatewayIp failed",
    );
  }
  return null;
}

/**
 * Base URL to scrape the host-network fw-agent's `/healthz`. Honours an explicit
 * `EGRESS_FW_AGENT_HEALTH_URL` override; otherwise derives it from the host
 * gateway IP + the known fw-agent health port. Returns `null` when unresolvable.
 */
export async function resolveFwAgentHealthBaseUrl(): Promise<string | null> {
  const override = process.env.EGRESS_FW_AGENT_HEALTH_URL;
  if (override && override.length > 0) return override.replace(/\/$/, "");
  const gw = await resolveHostGatewayIp();
  if (!gw) return null;
  return `http://${gw}:${FW_AGENT_HEALTH_PORT}`;
}

/**
 * The target container's IP on a docker network the server's own container is
 * also attached to (the shared `nats` network for gateways). Returns `null`
 * when there's no shared network or inspection fails. Never throws.
 */
async function resolveSharedNetworkIp(targetContainerId: string): Promise<string | null> {
  const ownId = getOwnContainerId();
  if (!ownId) return null;
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const [own, target] = await Promise.all([
      docker.getContainer(ownId).inspect(),
      docker.getContainer(targetContainerId).inspect(),
    ]);
    const ownNets = new Set(Object.keys(own.NetworkSettings?.Networks ?? {}));
    const targetNets = target.NetworkSettings?.Networks ?? {};
    for (const [name, net] of Object.entries(targetNets)) {
      const ip = (net as { IPAddress?: string })?.IPAddress;
      if (ownNets.has(name) && ip && ip.length > 0) return ip;
    }
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "resolveSharedNetworkIp failed",
    );
  }
  return null;
}

/**
 * Best-effort scrape of a specific environment's gateway `/healthz`, returning
 * just the connection state (or `null` when the gateway can't be found/reached).
 * Used to explain *why* a rules/container-map push to the gateway is failing —
 * `auth-failed` means the gateway's creds are rejected so it never subscribed.
 */
export async function scrapeGatewayConnState(
  environmentId: string,
): Promise<EgressAgentConnState | null> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const list = await docker.listContainers({
      filters: {
        label: [`mini-infra.service=egress-gateway`, `mini-infra.environment=${environmentId}`],
      },
    });
    if (list.length === 0) return null;
    const ip = await resolveSharedNetworkIp(list[0].Id);
    if (!ip) return null;
    const report = await scrapeAgentHealth(`http://${ip}:${GATEWAY_HEALTH_PORT}`);
    return report?.status ?? null;
  } catch (err) {
    log.debug(
      { environmentId, err: err instanceof Error ? err.message : String(err) },
      "scrapeGatewayConnState failed",
    );
    return null;
  }
}
