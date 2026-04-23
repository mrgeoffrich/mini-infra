import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VaultHttpClient, VaultHttpError } from "../vault-http-client";

describe("VaultHttpClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(
    impl: (url: string, init?: RequestInit) => {
      status: number;
      body: string;
      ok?: boolean;
    },
  ) {
    globalThis.fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const res = impl(String(url), init);
      return {
        status: res.status,
        ok: res.ok ?? res.status < 400,
        text: async () => res.body,
      } as Response;
    });
  }

  it("sends X-Vault-Token header when token is set", async () => {
    let seenHeaders: Headers | Record<string, string> | undefined;
    mockFetch((_url, init) => {
      seenHeaders = init?.headers as Record<string, string>;
      return { status: 200, body: JSON.stringify({ ok: true }) };
    });
    const client = new VaultHttpClient("http://vault", { token: "s.secret" });
    await client.request("GET", "some/path");
    expect((seenHeaders as Record<string, string>)["X-Vault-Token"]).toBe(
      "s.secret",
    );
  });

  it("parses error body into VaultHttpError", async () => {
    mockFetch(() => ({
      status: 400,
      body: JSON.stringify({ errors: ["bad request", "try again"] }),
    }));
    const client = new VaultHttpClient("http://vault");
    await expect(client.request("POST", "sys/init")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof VaultHttpError &&
        err.status === 400 &&
        err.errors.includes("bad request"),
    );
  });

  it("allow404 returns response body on 404 instead of throwing", async () => {
    mockFetch(() => ({
      status: 404,
      body: JSON.stringify({ errors: ["not found"] }),
    }));
    const client = new VaultHttpClient("http://vault");
    const res = await client.request("GET", "sys/policies/acl/missing", {
      allow404: true,
    });
    expect(res).toEqual({ errors: ["not found"] });
  });

  it("enableAuth is idempotent on 'path already in use'", async () => {
    mockFetch(() => ({
      status: 400,
      body: JSON.stringify({ errors: ["path already in use at approle/"] }),
    }));
    const client = new VaultHttpClient("http://vault", { token: "s.root" });
    await expect(client.enableAuth("approle", "approle")).resolves.not.toThrow();
  });

  it("circuit breaker opens after 5 consecutive failures", async () => {
    mockFetch(() => ({
      status: 500,
      body: JSON.stringify({ errors: ["boom"] }),
    }));
    const client = new VaultHttpClient("http://vault");
    for (let i = 0; i < 5; i += 1) {
      await expect(client.request("GET", "sys/health")).rejects.toBeInstanceOf(
        VaultHttpError,
      );
    }
    await expect(client.request("GET", "sys/health")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof VaultHttpError &&
        err.errors.includes("circuit-breaker-open"),
    );
  });

  it("health() returns null when fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new VaultHttpClient("http://vault");
    expect(await client.health()).toBeNull();
  });
});
