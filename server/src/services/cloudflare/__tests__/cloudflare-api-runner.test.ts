import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../../circuit-breaker";
import {
  CloudflareApiRunner,
  MissingCredentialsError,
} from "../cloudflare-api-runner";
import { ServiceError } from "../../../lib/error-handler";

const { mockCloudflareInstance } = vi.hoisted(() => ({
  mockCloudflareInstance: { marker: "mock-cf" },
}));

vi.mock("cloudflare", () => ({
  default: vi.fn().mockImplementation(function () {
    return mockCloudflareInstance;
  }),
}));

function buildBreaker(): CircuitBreaker {
  return new CircuitBreaker({
    serviceName: "Test",
    failureThreshold: 2,
    cooldownPeriodMs: 60_000,
    dedupWindowMs: 1,
    errorMappers: [
      { pattern: /timeout/, errorCode: "TIMEOUT", connectivityStatus: "timeout", isRetriable: true },
      { pattern: /auth/, errorCode: "AUTH", connectivityStatus: "failed", isRetriable: false },
    ],
    defaultErrorCode: "GENERIC",
  });
}

describe("CloudflareApiRunner", () => {
  let breaker: CircuitBreaker;
  let getApiToken: ReturnType<typeof vi.fn>;
  let getAccountId: ReturnType<typeof vi.fn>;
  let runner: CloudflareApiRunner;

  beforeEach(() => {
    breaker = buildBreaker();
    getApiToken = vi.fn().mockResolvedValue("token-1234567890");
    getAccountId = vi.fn().mockResolvedValue("account-abc");
    runner = new CloudflareApiRunner(breaker, getApiToken, getAccountId);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("withTimeout", () => {
    it("resolves when the underlying promise resolves in time", async () => {
      const result = await runner.withTimeout(
        Promise.resolve("ok"),
        "test call",
        1000,
      );
      expect(result).toBe("ok");
    });

    it("rejects with a labelled timeout after the deadline", async () => {
      vi.useFakeTimers();
      const pending = new Promise<string>(() => {
        /* never resolves */
      });
      const attempt = runner.withTimeout(pending, "slow call", 500);

      vi.advanceTimersByTime(500);
      await expect(attempt).rejects.toThrow("slow call timeout");
    });
  });

  describe("getAuthorizedClient", () => {
    it("builds a Cloudflare client when both credentials are present", async () => {
      const client = await runner.getAuthorizedClient();
      expect(client.apiToken).toBe("token-1234567890");
      expect(client.accountId).toBe("account-abc");
      expect(client.cf).toBe(mockCloudflareInstance);
    });

    it("throws MissingCredentialsError when api token is absent", async () => {
      getApiToken.mockResolvedValue(null);
      await expect(runner.getAuthorizedClient()).rejects.toBeInstanceOf(
        MissingCredentialsError,
      );
    });

    it("throws MissingCredentialsError when account id is absent", async () => {
      getAccountId.mockResolvedValue(null);
      await expect(runner.getAuthorizedClient()).rejects.toThrow(
        "Cloudflare account ID not configured",
      );
    });

    it("skips the account id check when requireAccountId is false", async () => {
      getAccountId.mockResolvedValue(null);
      const client = await runner.getAuthorizedClient({
        requireAccountId: false,
      });
      expect(client.accountId).toBe("");
      // getAccountId should not be consulted at all when the caller opts out.
      expect(getAccountId).not.toHaveBeenCalled();
    });
  });

  describe("run", () => {
    it("invokes the callback with an authorised client and returns its value", async () => {
      const result = await runner.run(
        { label: "probe" },
        async (client) => {
          expect(client.cf).toBe(mockCloudflareInstance);
          return { ok: 42 };
        },
      );
      expect(result).toEqual({ ok: 42 });
      // Success path should clear the breaker's failure count.
      expect(breaker.consecutiveFailures).toBe(0);
    });

    it("rejects when the circuit breaker is open", async () => {
      // Force the breaker open by recording enough failures.
      breaker.recordFailure("GENERIC");
      breaker.recordFailure("GENERIC");

      const fn = vi.fn();
      await expect(
        runner.run({ label: "probe" }, fn),
      ).rejects.toThrow("Circuit breaker is open, cannot execute probe");
      expect(fn).not.toHaveBeenCalled();
    });

    it("propagates MissingCredentialsError without wrapping it", async () => {
      getApiToken.mockResolvedValue(null);
      await expect(
        runner.run({ label: "probe" }, async () => "ignored"),
      ).rejects.toBeInstanceOf(MissingCredentialsError);
    });

    it("wraps API errors in a ServiceError and records the failure", async () => {
      const err = new Error("timeout of request");
      await expect(
        runner.run({ label: "probe" }, async () => {
          throw err;
        }),
      ).rejects.toBeInstanceOf(ServiceError);

      // Retriable errors should bump the breaker's failure counter.
      expect(breaker.consecutiveFailures).toBe(1);
    });

    it("does not count non-retriable errors towards the breaker", async () => {
      await expect(
        runner.run({ label: "probe" }, async () => {
          throw new Error("auth denied");
        }),
      ).rejects.toBeInstanceOf(ServiceError);

      expect(breaker.consecutiveFailures).toBe(0);
    });
  });

  describe("tryRun", () => {
    it("returns the callback's result on success", async () => {
      const result = await runner.tryRun(
        { label: "list" },
        [] as number[],
        async () => [1, 2, 3],
      );
      expect(result).toEqual([1, 2, 3]);
    });

    it("returns the fallback when the circuit breaker is open", async () => {
      breaker.recordFailure("GENERIC");
      breaker.recordFailure("GENERIC");

      const fn = vi.fn();
      const result = await runner.tryRun(
        { label: "list" },
        [] as number[],
        fn,
      );
      expect(result).toEqual([]);
      expect(fn).not.toHaveBeenCalled();
    });

    it("returns the fallback when credentials are missing", async () => {
      getApiToken.mockResolvedValue(null);
      const result = await runner.tryRun(
        { label: "list" },
        null as { data: number[] } | null,
        async () => ({ data: [1] }),
      );
      expect(result).toBeNull();
    });

    it("returns the fallback when the callback throws", async () => {
      const result = await runner.tryRun(
        { label: "list" },
        ["fallback"],
        async () => {
          throw new Error("timeout");
        },
      );
      expect(result).toEqual(["fallback"]);
      expect(breaker.consecutiveFailures).toBe(1);
    });
  });

  describe("cfdFetch", () => {
    it("sends requests with the configured auth header and prefix", async () => {
      const fetchSpy = vi
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response("{}"));

      await runner.cfdFetch(
        "/accounts/abc/cfd_tunnel/xyz/configurations",
        { method: "GET" },
        "tunnel fetch",
      );

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/abc/cfd_tunnel/xyz/configurations",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer token-1234567890",
            "Content-Type": "application/json",
          }),
        }),
      );
    });
  });
});
