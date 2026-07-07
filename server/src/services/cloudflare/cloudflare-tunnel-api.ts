import type { TunnelListResponse } from "cloudflare/resources/zero-trust/tunnels/tunnels.js";
import {
  CloudflareTunnelConfig,
  CloudflareTunnelIngressRule,
  ErrorCode,
} from "@mini-infra/types";
import { ConflictError, InternalError, NotFoundError } from "../../lib/errors";
import { CloudflareApiRunner } from "./cloudflare-api-runner";

/**
 * Tunnel and ingress-rule operations against the Cloudflare API.
 * All methods delegate their auth, timeout, circuit-breaker and error
 * handling to {@link CloudflareApiRunner}.
 */
export class CloudflareTunnelApi {
  constructor(private readonly runner: CloudflareApiRunner) {}

  /**
   * Fetch the ingress configuration for a specific tunnel.
   * Returns `null` if credentials are missing, the circuit is open, or
   * the Cloudflare API rejects the request — callers should treat that
   * as "configuration unavailable right now".
   */
  async getTunnelConfig(
    tunnelId: string,
  ): Promise<CloudflareTunnelConfig | null> {
    return this.runner.tryRun<CloudflareTunnelConfig | null>(
      { label: "tunnel config fetch", logContext: { tunnelId } },
      null,
      async ({ accountId }) => {
        const response = await this.runner.cfdFetch(
          `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
          {},
          "tunnel config fetch",
        );
        if (!response.ok) {
          // Swallowed by `tryRun()`'s catch-all into the `null` fallback below
          // — never reaches a caller as a thrown error.
          throw new InternalError(`HTTP ${response.status}: ${response.statusText}`);
        }
        const body = (await response.json()) as {
          success: boolean;
          result: CloudflareTunnelConfig;
        };
        return body.result;
      },
    );
  }

  /**
   * List every tunnel (excluding soft-deleted) in the configured account.
   * Returns `[]` on any failure — list views tolerate that gracefully.
   */
  async getTunnelInfo(): Promise<TunnelListResponse[]> {
    return this.runner.tryRun<TunnelListResponse[]>(
      { label: "tunnel list" },
      [],
      async ({ cf, accountId }) => {
        const response = await cf.zeroTrust.tunnels.list({
          account_id: accountId,
        });
        const tunnels = response.result ?? [];
        return tunnels.filter(
          (tunnel: TunnelListResponse) => !tunnel.deleted_at,
        );
      },
    );
  }

  /**
   * Overwrite the tunnel's ingress configuration. Throws
   * {@link ServiceError} on failure — callers should propagate.
   */
  async updateTunnelConfig(
    tunnelId: string,
    config: CloudflareTunnelConfig["config"],
  ): Promise<CloudflareTunnelConfig> {
    return this.runner.run<CloudflareTunnelConfig>(
      {
        label: "tunnel config update",
        logContext: {
          tunnelId,
          ingressRuleCount: config.ingress?.length ?? 0,
        },
      },
      async ({ accountId }) => {
        const response = await this.runner.cfdFetch(
          `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
          { method: "PUT", body: JSON.stringify({ config }) },
          "tunnel config update",
        );
        if (!response.ok) {
          const errorText = await response.text();
          // An unmapped HTTP failure from the raw cfdFetch call (no SDK
          // status/body shape to key a taxonomy error off of) — genuinely
          // internal/SDK-wrap, not a user-actionable condition on its own.
          throw new InternalError(`HTTP ${response.status}: ${errorText}`);
        }
        const body = (await response.json()) as {
          success: boolean;
          result: CloudflareTunnelConfig;
        };
        return body.result;
      },
    );
  }

  /**
   * Add a public hostname to the tunnel's ingress list, inserting before
   * the catch-all rule when one is present.
   */
  async addHostname(
    tunnelId: string,
    hostname: string,
    service: string,
    path?: string,
    originRequest?: { httpHostHeader?: string },
  ): Promise<CloudflareTunnelConfig> {
    const currentConfig = await this.getTunnelConfig(tunnelId);
    if (!currentConfig || !currentConfig.config) {
      throw new NotFoundError(
        ErrorCode.CLOUDFLARE_TUNNEL_CONFIG_UNAVAILABLE,
        "Unable to retrieve current tunnel configuration",
        {
          resource: { type: "cloudflareTunnelConfig", id: tunnelId },
          action: "Verify the tunnel exists and Cloudflare credentials are configured.",
        },
      );
    }

    const ingress = [...(currentConfig.config.ingress ?? [])];
    const existingIndex = ingress.findIndex(
      (rule) => rule.hostname === hostname && rule.path === path,
    );
    if (existingIndex !== -1) {
      throw new ConflictError(
        ErrorCode.CLOUDFLARE_TUNNEL_HOSTNAME_EXISTS,
        `Hostname ${hostname}${path ? ` with path ${path}` : ""} already exists`,
        {
          resource: { type: "cloudflareTunnelHostname", name: hostname },
          action: "Remove the existing hostname first, or choose a different one.",
        },
      );
    }

    const newRule: CloudflareTunnelIngressRule = { hostname, service };
    if (path) newRule.path = path;
    if (originRequest) newRule.originRequest = originRequest;

    const catchAllIndex = ingress.findIndex((rule) => !rule.hostname);
    if (catchAllIndex !== -1) {
      ingress.splice(catchAllIndex, 0, newRule);
    } else {
      ingress.push(newRule);
    }

    return this.updateTunnelConfig(tunnelId, {
      ...currentConfig.config,
      ingress,
    });
  }

  /**
   * Remove a hostname (optionally scoped by path) from the tunnel's
   * ingress list. Throws if the hostname isn't present.
   */
  async removeHostname(
    tunnelId: string,
    hostname: string,
    path?: string,
  ): Promise<CloudflareTunnelConfig> {
    const currentConfig = await this.getTunnelConfig(tunnelId);
    if (!currentConfig || !currentConfig.config) {
      throw new NotFoundError(
        ErrorCode.CLOUDFLARE_TUNNEL_CONFIG_UNAVAILABLE,
        "Unable to retrieve current tunnel configuration",
        {
          resource: { type: "cloudflareTunnelConfig", id: tunnelId },
          action: "Verify the tunnel exists and Cloudflare credentials are configured.",
        },
      );
    }

    const ingress = [...(currentConfig.config.ingress ?? [])];
    const ruleIndex = ingress.findIndex(
      (rule) =>
        rule.hostname === hostname &&
        (path ? rule.path === path : !rule.path),
    );

    if (ruleIndex === -1) {
      throw new NotFoundError(
        ErrorCode.CLOUDFLARE_TUNNEL_HOSTNAME_NOT_FOUND,
        `Hostname ${hostname}${path ? ` with path ${path}` : ""} not found`,
        {
          resource: { type: "cloudflareTunnelHostname", name: hostname },
          action: "Check the tunnel's hostname list and try again.",
        },
      );
    }

    ingress.splice(ruleIndex, 1);

    return this.updateTunnelConfig(tunnelId, {
      ...currentConfig.config,
      ingress,
    });
  }
}
