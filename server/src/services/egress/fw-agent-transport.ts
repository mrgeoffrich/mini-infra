/**
 * Server-side transport to the egress-fw-agent.
 *
 * Today (ALT-27) the default transport is NATS — the server publishes
 * `mini-infra.egress.fw.rules.apply` and the agent replies on `_INBOX.<auto>`.
 * The legacy Unix-socket HTTP admin API is kept compiled for one release
 * behind `MINI_INFRA_FW_AGENT_TRANSPORT=unix` as a rollback path. The
 * higher-level `FwAgentTransport` interface lets `env-firewall-manager.ts`
 * stay transport-agnostic — flipping the env var swaps implementations.
 *
 * Rollback removal tracked as a follow-up issue (per the plan doc §6
 * Phase 2 — "Old transport stays compiled for one release behind a
 * feature flag for rollback; flag is removed in the follow-up clean-up
 * issue").
 */

import { createConnection } from "net";
import { randomUUID } from "node:crypto";
import { EgressFwSubject } from "@mini-infra/types";
import type {
  EgressFwRulesApplyReply,
  EgressFwRulesApplyRequest,
} from "../nats/payload-schemas";
// `NatsBus` is imported as a type only — its runtime import has a heavy
// transitive prisma dependency chain that breaks unit tests of consumers
// of this transport (env-firewall-manager). The actual instance is fetched
// lazily inside the NatsTransport methods via `loadNatsBus()`, which is
// stubbable through a test override.
import type { NatsBus } from "../nats/nats-bus";
import { getLogger } from "../../lib/logger-factory";

export const DEFAULT_FW_AGENT_SOCKET_PATH = "/var/run/mini-infra/fw.sock";
const FW_AGENT_REQUEST_TIMEOUT_MS = 5_000;
const log = getLogger("integrations", "fw-agent-transport");

// ---------------------------------------------------------------------------
// High-level transport — one method per legacy admin endpoint
// ---------------------------------------------------------------------------

export type FirewallMode = "observe" | "enforce";

export interface FwAgentApplyResult {
  /** Mirrors the legacy fetcher's HTTP status code so callers' branch logic
   *  doesn't have to change. 200 = applied; 4xx/5xx = rejected. The unix
   *  fetcher passes through real HTTP status; the NATS transport uses 200
   *  on `applied`, 502 on `rejected` so existing "non-200" warns still fire. */
  status: number;
  /** Original reply body for diagnostics. Optional under both transports. */
  body?: unknown;
}

/**
 * Operations the server can request from the fw-agent. Names mirror the
 * Phase 2 discriminated-union `op` values 1:1 — keeps grep-ability across
 * the two languages aligned.
 */
export interface FwAgentTransport {
  envUpsert(input: { envName: string; bridgeCidr: string; mode: FirewallMode }): Promise<FwAgentApplyResult>;
  envRemove(input: { envName: string }): Promise<FwAgentApplyResult>;
  ipsetAdd(input: { envName: string; ip: string }): Promise<FwAgentApplyResult>;
  ipsetDel(input: { envName: string; ip: string }): Promise<FwAgentApplyResult>;
  ipsetSync(input: { envName: string; ips: string[] }): Promise<FwAgentApplyResult>;
}

/**
 * Pick the active transport from env. Default: nats. Logged once per
 * process; subsequent calls hit the cache.
 */
let cachedTransport: FwAgentTransport | null = null;
export function getFwAgentTransport(): FwAgentTransport {
  if (cachedTransport) return cachedTransport;
  const mode = (process.env.MINI_INFRA_FW_AGENT_TRANSPORT ?? "nats").toLowerCase();
  if (mode === "unix") {
    log.warn(
      { mode, socketPath: getFwAgentSocketPath() },
      "fw-agent transport: using legacy Unix-socket transport (MINI_INFRA_FW_AGENT_TRANSPORT=unix)",
    );
    cachedTransport = new UnixSocketTransport(getFwAgentSocketPath());
  } else {
    log.info({ mode }, "fw-agent transport: using NATS (default)");
    cachedTransport = new NatsTransport();
  }
  return cachedTransport;
}

/** Reset the cached transport. For tests only. */
export function __resetFwAgentTransportForTests(): void {
  cachedTransport = null;
}

// ---------------------------------------------------------------------------
// NATS transport (default, ALT-27)
// ---------------------------------------------------------------------------

/**
 * Lazy loader for `NatsBus.getInstance()`. Test override via
 * `__setNatsBusLoaderForTests()` lets unit tests inject a fake without
 * pulling in the prisma-heavy nats-bus module at import time.
 */
let natsBusLoader: () => NatsBus = () => {
  // require is intentional — defers the heavy dependency chain until
  // the NATS transport is actually exercised.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../nats/nats-bus") as typeof import("../nats/nats-bus");
  return mod.NatsBus.getInstance();
};

/** Test hook to inject a fake NatsBus. Production code never calls this. */
export function __setNatsBusLoaderForTests(loader: () => NatsBus): void {
  natsBusLoader = loader;
}

class NatsTransport implements FwAgentTransport {
  async envUpsert(input: { envName: string; bridgeCidr: string; mode: FirewallMode }): Promise<FwAgentApplyResult> {
    return this.send({ op: "env-upsert", applyId: newApplyId(), ...input });
  }
  async envRemove(input: { envName: string }): Promise<FwAgentApplyResult> {
    return this.send({ op: "env-remove", applyId: newApplyId(), envName: input.envName });
  }
  async ipsetAdd(input: { envName: string; ip: string }): Promise<FwAgentApplyResult> {
    return this.send({ op: "ipset-add", applyId: newApplyId(), ...input });
  }
  async ipsetDel(input: { envName: string; ip: string }): Promise<FwAgentApplyResult> {
    return this.send({ op: "ipset-del", applyId: newApplyId(), ...input });
  }
  async ipsetSync(input: { envName: string; ips: string[] }): Promise<FwAgentApplyResult> {
    return this.send({ op: "ipset-sync", applyId: newApplyId(), ...input });
  }

  private async send(req: EgressFwRulesApplyRequest): Promise<FwAgentApplyResult> {
    const bus = natsBusLoader();
    const reply = await bus.request<EgressFwRulesApplyRequest, EgressFwRulesApplyReply>(
      EgressFwSubject.rulesApply,
      req,
      { timeoutMs: FW_AGENT_REQUEST_TIMEOUT_MS },
    );
    if (reply.status === "applied") {
      return { status: 200, body: reply };
    }
    // Match the legacy "non-200 → warn, queue / retry" branch in env-firewall-
    // manager. 502 (Bad Gateway) is an honest mapping: the transport got a
    // structured rejection from the upstream, not a transport failure.
    return { status: 502, body: reply };
  }
}

function newApplyId(): string {
  return `fw-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Legacy Unix-socket transport (rollback only)
// ---------------------------------------------------------------------------

export function getFwAgentSocketPath(): string {
  return process.env.FW_AGENT_SOCKET_PATH ?? DEFAULT_FW_AGENT_SOCKET_PATH;
}

class UnixSocketTransport implements FwAgentTransport {
  constructor(private readonly socketPath: string) {}

  envUpsert(input: { envName: string; bridgeCidr: string; mode: FirewallMode }): Promise<FwAgentApplyResult> {
    return this.fetch({
      method: "POST",
      path: "/v1/env",
      body: { env: input.envName, bridgeCidr: input.bridgeCidr, mode: input.mode },
    });
  }
  envRemove(input: { envName: string }): Promise<FwAgentApplyResult> {
    return this.fetch({ method: "DELETE", path: `/v1/env/${input.envName}` });
  }
  ipsetAdd(input: { envName: string; ip: string }): Promise<FwAgentApplyResult> {
    return this.fetch({
      method: "POST",
      path: `/v1/ipset/${input.envName}/managed/add`,
      body: { ip: input.ip },
    });
  }
  ipsetDel(input: { envName: string; ip: string }): Promise<FwAgentApplyResult> {
    return this.fetch({
      method: "POST",
      path: `/v1/ipset/${input.envName}/managed/del`,
      body: { ip: input.ip },
    });
  }
  ipsetSync(input: { envName: string; ips: string[] }): Promise<FwAgentApplyResult> {
    return this.fetch({
      method: "POST",
      path: `/v1/ipset/${input.envName}/managed/sync`,
      body: { ips: input.ips },
    });
  }

  private fetch(req: { method: "GET" | "POST" | "DELETE"; path: string; body?: unknown }): Promise<FwAgentApplyResult> {
    return new Promise<FwAgentApplyResult>((resolve, reject) => {
      const bodyStr = req.body ? JSON.stringify(req.body) : "";
      const headers: string[] = [
        `${req.method} ${req.path} HTTP/1.1`,
        "Host: localhost",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(bodyStr)}`,
        "Connection: close",
        "",
        bodyStr,
      ];
      const rawRequest = headers.join("\r\n");

      const socket = createConnection(this.socketPath);
      let rawResponse = "";

      socket.setTimeout(FW_AGENT_REQUEST_TIMEOUT_MS);
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error(`fw-agent socket timeout: ${this.socketPath}`));
      });

      socket.on("error", (err) => {
        reject(new Error(`fw-agent socket error: ${err.message}`));
      });

      socket.on("data", (chunk) => {
        rawResponse += chunk.toString("utf-8");
      });

      socket.on("end", () => {
        try {
          const lines = rawResponse.split("\r\n");
          const statusLine = lines[0] ?? "";
          const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;

          const bodyStart = rawResponse.indexOf("\r\n\r\n");
          const rawBody = bodyStart >= 0 ? rawResponse.slice(bodyStart + 4) : "";
          let body: unknown;
          try {
            body = rawBody ? JSON.parse(rawBody) : null;
          } catch {
            body = rawBody;
          }
          resolve({ status, body });
        } catch (err) {
          reject(err);
        }
      });

      socket.write(rawRequest);
    });
  }
}
