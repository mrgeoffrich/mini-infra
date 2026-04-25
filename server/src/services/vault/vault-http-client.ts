import { getLogger } from "../../lib/logger-factory";

const log = getLogger("platform", "vault-http-client");

export interface VaultHealthResponse {
  initialized?: boolean;
  sealed?: boolean;
  standby?: boolean;
  version?: string;
  cluster_id?: string;
  cluster_name?: string;
}

export interface VaultSealStatus {
  sealed: boolean;
  t: number; // threshold
  n: number; // shares
  progress: number;
  initialized?: boolean;
  version?: string;
}

export interface VaultInitResponse {
  keys: string[];
  keys_base64: string[];
  root_token: string;
}

export interface VaultAppRoleReadResponse {
  data: {
    role_id: string;
  };
}

export interface VaultAppRoleSecretIdResponse {
  data: {
    secret_id: string;
    secret_id_accessor: string;
  };
}

export interface VaultWrappedResponse {
  wrap_info: {
    token: string;
    ttl: number;
    creation_time: string;
    creation_path: string;
    accessor?: string;
  };
}

export interface VaultAuthResponse {
  auth: {
    client_token: string;
    /** Lease duration in seconds */
    lease_duration?: number;
    renewable?: boolean;
    token_policies?: string[];
  };
}

export class VaultHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: string[] = [],
  ) {
    super(message);
    this.name = "VaultHttpError";
  }
}

/**
 * Thin wrapper around the OpenBao / Vault HTTP API.
 *
 * Modelled on `BaoClient` from slackbot-agent-sdk/environment/vault/bootstrap.ts
 * but with:
 *   - request-level timeouts
 *   - circuit-breaker-style short-circuit when recently-failed
 *   - structured errors via VaultHttpError
 *   - typed convenience methods for the admin paths Mini Infra uses
 */
export class VaultHttpClient {
  private token: string | null = null;
  private readonly requestTimeoutMs: number;
  private circuitBreaker = {
    consecutiveFailures: 0,
    openUntil: 0,
  };

  constructor(
    private readonly address: string,
    opts: { token?: string | null; requestTimeoutMs?: number } = {},
  ) {
    this.token = opts.token ?? null;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  }

  get addr(): string {
    return this.address;
  }

  setToken(token: string | null): void {
    this.token = token;
    // A fresh token means the caller has done something to recover from a
    // bad-auth failure path. Reset the circuit breaker so subsequent requests
    // aren't short-circuited by stale failures against the old token.
    this.resetCircuit();
  }

  clearToken(): void {
    this.token = null;
    this.resetCircuit();
  }

  resetCircuit(): void {
    this.circuitBreaker.consecutiveFailures = 0;
    this.circuitBreaker.openUntil = 0;
  }

  /**
   * Make an authenticated request to /v1/<path>. Non-2xx responses throw
   * VaultHttpError with any `errors` array from the Vault response body.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      timeoutMs?: number;
      allow404?: boolean;
    } = {},
  ): Promise<T> {
    if (this.isCircuitOpen()) {
      throw new VaultHttpError(
        "Vault circuit breaker is open (too many recent failures)",
        0,
        ["circuit-breaker-open"],
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    };
    if (this.token && !("X-Vault-Token" in headers)) {
      headers["X-Vault-Token"] = this.token;
    }

    const url = `${this.address}/v1/${path.replace(/^\//, "")}`;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      this.recordFailure();
      const msg = err instanceof Error ? err.message : String(err);
      throw new VaultHttpError(
        `Vault request failed: ${method} ${path}: ${msg}`,
        0,
        [msg],
      );
    }
    clearTimeout(timer);

    const text = await res.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!res.ok) {
      if (res.status === 404 && options.allow404) {
        // Callers that expect 404 as "not found" can recover
        this.recordSuccess();
        return data as T;
      }
      this.recordFailure();
      const errors = (data as { errors?: string[] })?.errors ?? [
        `HTTP ${res.status}`,
      ];
      throw new VaultHttpError(
        `Vault ${method} /v1/${path} failed: ${errors.join(", ")}`,
        res.status,
        errors,
      );
    }

    this.recordSuccess();
    return data as T;
  }

  // ── Health / seal ──────────────────────────────────────

  /**
   * Probe /v1/sys/health. Returns null when Vault is unreachable.
   * Uses `uninitcode=200&sealedcode=200` so non-standard states still return JSON.
   */
  async health(): Promise<VaultHealthResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await fetch(
        `${this.address}/v1/sys/health?uninitcode=200&sealedcode=200&standbycode=200`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      const text = await res.text();
      if (!text) return {};
      return JSON.parse(text) as VaultHealthResponse;
    } catch (err) {
      clearTimeout(timer);
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "Vault health probe failed",
      );
      return null;
    }
  }

  async sealStatus(): Promise<VaultSealStatus> {
    return this.request<VaultSealStatus>("GET", "sys/seal-status");
  }

  // ── Initialise & unseal ────────────────────────────────

  async init(secretShares: number, secretThreshold: number): Promise<VaultInitResponse> {
    return this.request<VaultInitResponse>("POST", "sys/init", {
      body: { secret_shares: secretShares, secret_threshold: secretThreshold },
    });
  }

  async unsealSubmit(key: string): Promise<VaultSealStatus> {
    return this.request<VaultSealStatus>("POST", "sys/unseal", {
      body: { key },
    });
  }

  // ── Auth methods / policies ────────────────────────────

  async enableAuth(path: string, type: string, description?: string): Promise<void> {
    try {
      await this.request("POST", `sys/auth/${path}`, {
        body: { type, description },
      });
    } catch (err) {
      // Treat "path already in use" as idempotent success
      if (err instanceof VaultHttpError && err.errors.some((e) => /already in use/i.test(e))) {
        return;
      }
      throw err;
    }
  }

  async enableKvV2(path: string): Promise<void> {
    try {
      await this.request("POST", `sys/mounts/${path}`, {
        body: { type: "kv", options: { version: "2" } },
      });
    } catch (err) {
      if (err instanceof VaultHttpError && err.errors.some((e) => /already in use/i.test(e))) {
        return;
      }
      throw err;
    }
  }

  async writePolicy(name: string, hclBody: string): Promise<void> {
    await this.request("PUT", `sys/policies/acl/${name}`, {
      body: { policy: hclBody },
    });
  }

  async deletePolicy(name: string): Promise<void> {
    await this.request("DELETE", `sys/policies/acl/${name}`, { allow404: true });
  }

  // ── AppRole ───────────────────────────────────────────

  async writeAppRole(
    name: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    await this.request("POST", `auth/approle/role/${name}`, { body: config });
  }

  async deleteAppRole(name: string): Promise<void> {
    await this.request("DELETE", `auth/approle/role/${name}`, { allow404: true });
  }

  async readAppRoleId(name: string): Promise<string> {
    const res = await this.request<VaultAppRoleReadResponse>(
      "GET",
      `auth/approle/role/${name}/role-id`,
    );
    return res.data.role_id;
  }

  async mintAppRoleSecretId(name: string): Promise<string> {
    const res = await this.request<VaultAppRoleSecretIdResponse>(
      "POST",
      `auth/approle/role/${name}/secret-id`,
      { body: {} },
    );
    return res.data.secret_id;
  }

  async mintWrappedAppRoleSecretId(
    name: string,
    wrapTtlSeconds: number,
  ): Promise<VaultWrappedResponse> {
    return this.request<VaultWrappedResponse>(
      "POST",
      `auth/approle/role/${name}/secret-id`,
      {
        body: {},
        headers: { "X-Vault-Wrap-TTL": `${wrapTtlSeconds}s` },
      },
    );
  }

  // ── Userpass ──────────────────────────────────────────

  async createUserpassUser(
    username: string,
    password: string,
    policies: string[],
  ): Promise<void> {
    await this.request("POST", `auth/userpass/users/${username}`, {
      body: { password, policies: policies.join(",") },
    });
  }

  // ── Token lifecycle ───────────────────────────────────

  async lookupSelf(): Promise<unknown> {
    return this.request("GET", "auth/token/lookup-self");
  }

  async revokeSelf(): Promise<void> {
    await this.request("POST", "auth/token/revoke-self");
  }

  /** AppRole login returns a full token response; caller extracts client_token */
  async appRoleLogin(
    roleId: string,
    secretId: string,
  ): Promise<VaultAuthResponse> {
    return this.request<VaultAuthResponse>("POST", "auth/approle/login", {
      body: { role_id: roleId, secret_id: secretId },
    });
  }

  /** Renew the current X-Vault-Token (in-place). Returns the auth response. */
  async renewSelf(increment?: string): Promise<VaultAuthResponse> {
    return this.request<VaultAuthResponse>("POST", "auth/token/renew-self", {
      body: increment ? { increment } : {},
    });
  }

  // ── KV v2 ─────────────────────────────────────────────

  async kvWrite(mount: string, path: string, data: Record<string, unknown>): Promise<void> {
    await this.request("POST", `${mount}/data/${path}`, {
      body: { data },
    });
  }

  async kvRead(mount: string, path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.request<{ data?: { data?: Record<string, unknown> } }>(
        "GET",
        `${mount}/data/${path}`,
        { allow404: true },
      );
      return res?.data?.data ?? null;
    } catch (err) {
      if (err instanceof VaultHttpError && err.status === 404) return null;
      throw err;
    }
  }

  // ── Circuit breaker ───────────────────────────────────

  private isCircuitOpen(): boolean {
    return Date.now() < this.circuitBreaker.openUntil;
  }

  private recordFailure(): void {
    this.circuitBreaker.consecutiveFailures += 1;
    if (this.circuitBreaker.consecutiveFailures >= 5) {
      // Open for 5 seconds — short enough that the operator can retry
      // quickly once the underlying issue (e.g. sealed) is resolved.
      this.circuitBreaker.openUntil = Date.now() + 5_000;
    }
  }

  private recordSuccess(): void {
    this.circuitBreaker.consecutiveFailures = 0;
    this.circuitBreaker.openUntil = 0;
  }
}
