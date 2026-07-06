/**
 * Tests for the shared typed HTTP client (`apiFetch` / `ApiRequestError`).
 * Covers: credentials + header attachment, typed-error throwing on non-2xx
 * responses, request timeout via AbortSignal, and envelope unwrapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpHeader } from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

type FetchCall = [string, RequestInit];

function getFetchCall(index = 0): FetchCall {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls[index] as FetchCall;
}

describe("apiFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches credentials and the standard headers", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ success: true, data: { foo: "bar" } }),
    } as Response);

    await apiFetch("/api/widgets");

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = getFetchCall();
    expect(url).toBe("/api/widgets");
    expect(init.credentials).toBe("include");

    const headers = init.headers as Record<string, string>;
    expect(headers[HttpHeader.ContentType]).toBe("application/json");
    // Correlation ID defaults to a "req-<epoch-ms>-<7 char base36>" shape.
    expect(headers[HttpHeader.CorrelationId]).toMatch(/^req-\d+-[a-z0-9]{7}$/);
  });

  it("uses the supplied correlation-ID prefix", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ success: true, data: [] }),
    } as Response);

    await apiFetch("/api/containers", { correlationIdPrefix: "containers" });

    const [, init] = getFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers[HttpHeader.CorrelationId]).toMatch(/^containers-\d+-[a-z0-9]{7}$/);
  });

  it("JSON-stringifies a non-string body and sets the method", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ success: true, data: { id: "1" } }),
    } as Response);

    await apiFetch("/api/widgets/1", {
      method: "PATCH",
      body: { name: "new-name" },
    });

    const [, init] = getFetchCall();
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ name: "new-name" }));
  });

  it("unwraps the {success, data} envelope on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ success: true, data: { containers: [], totalCount: 0 } }),
    } as Response);

    const result = await apiFetch("/api/containers");
    expect(result).toEqual({ containers: [], totalCount: 0 });
  });

  it("throws a typed ApiRequestError carrying the HTTP status on a non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: () =>
        Promise.resolve({
          error: "Service Unavailable",
          message: "Docker service is not available. Please try again later.",
        }),
    } as Response);

    const error = await apiFetch("/api/containers").catch((e) => e);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.status).toBe(503);
    expect(error.code).toBe("Service Unavailable");
    expect(error.message).toBe("Docker service is not available. Please try again later.");
    expect(error.isAuth).toBe(false);
    expect(error.isServer).toBe(true);
  });

  it("flags 401 responses via isAuth and 5xx via isServer", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: () => Promise.resolve({ error: "Unauthorized", message: "Login required" }),
    } as Response);

    const error: ApiRequestError = await apiFetch("/api/containers").catch((e) => e);
    expect(error.status).toBe(401);
    expect(error.isAuth).toBe(true);
    expect(error.isServer).toBe(false);
  });

  it("throws ApiRequestError when the envelope reports success: false on a 2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ success: false, message: "Failed to fetch containers" }),
    } as Response);

    await expect(apiFetch("/api/containers")).rejects.toMatchObject({
      message: "Failed to fetch containers",
    });
  });

  it("times out and throws a typed ApiRequestError when the abort signal fires", async () => {
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation timed out.", "TimeoutError"));
        });
      });
    });

    const error: ApiRequestError = await apiFetch("/api/containers", {
      timeoutMs: 5,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.code).toBe("TIMEOUT");
    expect(error.status).toBe(0);
  });
});
