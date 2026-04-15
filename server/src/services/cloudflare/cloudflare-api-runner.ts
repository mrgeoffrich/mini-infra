import Cloudflare from "cloudflare";
import { CircuitBreaker } from "../circuit-breaker";
import { getLogger } from "../../lib/logger-factory";
import { toServiceError } from "../../lib/service-error-mapper";

export const CLOUDFLARE_TIMEOUT_MS = 10_000;

/**
 * Thrown when required Cloudflare credentials (api_token / account_id) are
 * missing. Callers using {@link CloudflareApiRunner.tryRun} have this folded
 * into the fallback; callers using {@link CloudflareApiRunner.run} see it
 * propagate so they can decide how to surface the misconfiguration.
 */
export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

export interface AuthorizedCloudflareClient {
  cf: Cloudflare;
  apiToken: string;
  /** Empty string when the caller opted out with `requireAccountId: false`. */
  accountId: string;
}

export interface ApiCallContext {
  label: string;
  logContext?: Record<string, unknown>;
  requireAccountId?: boolean;
  timeoutMs?: number;
}

export type ApiCallFn<T> = (client: AuthorizedCloudflareClient) => Promise<T>;

/**
 * CloudflareApiRunner centralises the circuit-breaker / auth / timeout /
 * error-mapping boilerplate that every Cloudflare API call used to repeat.
 *
 * - `run()` throws a {@link ServiceError} on any failure — use when callers
 *   should propagate the error.
 * - `tryRun()` returns a supplied fallback on any failure — use when callers
 *   degrade gracefully (e.g. list views that tolerate missing data).
 */
export class CloudflareApiRunner {
  constructor(
    private readonly circuitBreaker: CircuitBreaker,
    private readonly getApiToken: () => Promise<string | null>,
    private readonly getAccountId: () => Promise<string | null>,
  ) {}

  withTimeout<T>(
    promise: Promise<T>,
    label: string,
    timeoutMs: number = CLOUDFLARE_TIMEOUT_MS,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label} timeout`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  /**
   * Build an authorised Cloudflare SDK client, throwing
   * {@link MissingCredentialsError} if either credential is absent.
   * Passing `requireAccountId: false` permits endpoints that only need
   * a token (e.g. `/zones` list with no account filter).
   */
  async getAuthorizedClient(
    opts: { requireAccountId?: boolean } = {},
  ): Promise<AuthorizedCloudflareClient> {
    const apiToken = await this.getApiToken();
    if (!apiToken) {
      throw new MissingCredentialsError("Cloudflare API token not configured");
    }

    let accountId = "";
    if (opts.requireAccountId !== false) {
      const id = await this.getAccountId();
      if (!id) {
        throw new MissingCredentialsError(
          "Cloudflare account ID not configured",
        );
      }
      accountId = id;
    }

    return { cf: new Cloudflare({ apiToken }), apiToken, accountId };
  }

  /**
   * Issue an authenticated request to the raw Cloudflare v4 REST API.
   * The typed SDK does not expose every endpoint (e.g. tunnel
   * configurations), so we fall back to fetch for those.
   */
  async cfdFetch(
    path: string,
    init: RequestInit,
    label: string,
    timeoutMs: number = CLOUDFLARE_TIMEOUT_MS,
  ): Promise<Response> {
    const { apiToken } = await this.getAuthorizedClient({
      requireAccountId: false,
    });
    return this.withTimeout(
      fetch(`https://api.cloudflare.com/client/v4${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      }),
      label,
      timeoutMs,
    );
  }

  /**
   * Run an API call that propagates failures. Throws {@link ServiceError}
   * on API errors and {@link MissingCredentialsError} when credentials
   * are absent.
   */
  async run<T>(ctx: ApiCallContext, fn: ApiCallFn<T>): Promise<T> {
    const { label, logContext = {}, requireAccountId, timeoutMs } = ctx;

    if (this.circuitBreaker.isOpen()) {
      throw new Error(`Circuit breaker is open, cannot execute ${label}`);
    }

    try {
      const client = await this.getAuthorizedClient({ requireAccountId });
      const result = await this.withTimeout(fn(client), label, timeoutMs);
      this.circuitBreaker.recordSuccess();
      getLogger("integrations", "cloudflare-api-runner").info(
        this.circuitBreaker.redact({ ...logContext }),
        `Cloudflare ${label} succeeded`,
      );
      return result;
    } catch (error) {
      if (error instanceof MissingCredentialsError) {
        throw error;
      }
      this.handleFailure(error, label, logContext);
      throw toServiceError(error, "cloudflare");
    }
  }

  /**
   * Run an API call that degrades to {@link fallback} on any failure
   * (circuit open, missing credentials, or API error).
   */
  async tryRun<T>(
    ctx: ApiCallContext,
    fallback: T,
    fn: ApiCallFn<T>,
  ): Promise<T> {
    const { label, logContext = {}, requireAccountId, timeoutMs } = ctx;

    if (this.circuitBreaker.isOpen()) {
      getLogger("integrations", "cloudflare-api-runner").warn(
        {
          ...logContext,
          circuitState: "open",
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
        },
        `Circuit breaker is open, skipping ${label}`,
      );
      return fallback;
    }

    try {
      const client = await this.getAuthorizedClient({ requireAccountId });
      const result = await this.withTimeout(fn(client), label, timeoutMs);
      this.circuitBreaker.recordSuccess();
      getLogger("integrations", "cloudflare-api-runner").info(
        this.circuitBreaker.redact({ ...logContext }),
        `Cloudflare ${label} succeeded`,
      );
      return result;
    } catch (error) {
      if (error instanceof MissingCredentialsError) {
        getLogger("integrations", "cloudflare-api-runner").warn(
          { ...logContext, reason: error.message },
          `Cannot execute ${label}`,
        );
        return fallback;
      }
      this.handleFailure(error, label, logContext);
      return fallback;
    }
  }

  private handleFailure(
    error: unknown,
    label: string,
    logContext: Record<string, unknown>,
  ): void {
    const { errorCode, isRetriable } = this.circuitBreaker.parseError(error);
    if (isRetriable) {
      this.circuitBreaker.recordFailure(errorCode);
    }
    getLogger("integrations", "cloudflare-api-runner").error(
      this.circuitBreaker.redact({
        ...logContext,
        error: error instanceof Error ? error.message : "Unknown error",
        errorCode,
        isRetriable,
      }),
      `Cloudflare ${label} failed`,
    );
  }
}
