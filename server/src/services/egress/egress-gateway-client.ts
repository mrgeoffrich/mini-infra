/**
 * EgressGatewayClient
 *
 * Thin HTTP client to the egress-gateway sidecar's admin API.
 * Uses native fetch with an AbortController-based timeout.
 * Non-2xx responses throw an EgressGatewayError with the status code and
 * parsed body. Retries are the caller's responsibility.
 */

import { getLogger } from '../../lib/logger-factory';

const log = getLogger('stacks', 'egress-gateway-client');

// ---------------------------------------------------------------------------
// Types (mirror egress-sidecar/src/types.ts — only what the client sends/receives)
// ---------------------------------------------------------------------------

export interface ContainerMapEntry {
  ip: string;
  stackId: string;
  serviceName: string;
  containerId?: string;
}

export interface ContainerMapRequest {
  version: number;
  entries: ContainerMapEntry[];
}

export interface ContainerMapResponse {
  version: number;
  accepted: true;
  entryCount: number;
}

export interface AdminHealthResponse {
  ok: true;
  rulesVersion: number;
  uptimeSeconds: number;
  /** Whether each listener is accepting connections (as reported by the Go admin server). */
  listeners: {
    proxy: boolean;
    admin: boolean;
  };
}

// ---------------------------------------------------------------------------
// Rules snapshot types (mirror egress-sidecar/src/types.ts)
// ---------------------------------------------------------------------------

export interface EgressRuleEntry {
  id: string;
  pattern: string;
  action: 'allow' | 'block';
  /** Service names within the stack this rule applies to; [] = all services */
  targets: string[];
}

export interface StackPolicyEntry {
  mode: 'detect' | 'enforce';
  defaultAction: 'allow' | 'block';
  rules: EgressRuleEntry[];
}

export interface RulesSnapshotRequest {
  version: number;
  /** Map of stackId -> policy */
  stackPolicies: Record<string, StackPolicyEntry>;
}

export interface RulesSnapshotResponse {
  version: number;
  accepted: true;
  ruleCount: number;
  stackCount: number;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class EgressGatewayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'EgressGatewayError';
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class EgressGatewayClient {
  private readonly baseUrl: string;

  constructor(
    private readonly gatewayIp: string,
    private readonly adminPort: number = 8054,
    private readonly timeoutMs: number = 5000,
  ) {
    this.baseUrl = `http://${gatewayIp}:${adminPort}`;
  }

  /**
   * Push a full container-map snapshot to the gateway.
   */
  async pushContainerMap(
    req: ContainerMapRequest,
  ): Promise<{ version: number; entryCount: number }> {
    const res = await this._request('POST', '/admin/container-map', req);
    const data = res as ContainerMapResponse;
    return { version: data.version, entryCount: data.entryCount };
  }

  /**
   * Push a full rules snapshot to the gateway.
   */
  async pushRules(
    req: RulesSnapshotRequest,
  ): Promise<{ version: number; ruleCount: number; stackCount: number; accepted: boolean }> {
    const res = await this._request('POST', '/admin/rules', req);
    const data = res as RulesSnapshotResponse;
    return {
      version: data.version,
      ruleCount: data.ruleCount,
      stackCount: data.stackCount,
      accepted: data.accepted,
    };
  }

  /**
   * Fetch the gateway's health status.
   */
  async health(): Promise<AdminHealthResponse> {
    return (await this._request('GET', '/admin/health')) as AdminHealthResponse;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    log.debug({ method, url }, 'egress-gateway request');

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `egress-gateway request timed out after ${this.timeoutMs}ms`
          : `egress-gateway request failed: ${err instanceof Error ? err.message : String(err)}`;
      throw new EgressGatewayError(message, 0);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text().catch(() => undefined);
      }
      throw new EgressGatewayError(
        `egress-gateway responded with ${response.status}`,
        response.status,
        errorBody,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new EgressGatewayError(
        'egress-gateway response was not valid JSON',
        response.status,
      );
    }
  }
}
