/**
 * Tests for the shared `QueryClient` factory (Phase 5 of
 * docs/planning/not-shipped/frontend-backend-contract-plan.md):
 *   - the typed default retry policy (`defaultQueryRetry` / `defaultQueryRetryDelay`)
 *   - the global 401 handler wired onto the `QueryCache`/`MutationCache`,
 *     including the exactly-once redirect latch under concurrent 401s
 *   - Phase 2 of docs/planning/not-shipped/error-handling-overhaul-plan.md
 *     (§4.4): the `MutationCache.onError` default-toasts non-401 mutation
 *     errors via `toastApiError`, with a `meta.skipErrorToast` opt-out
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClientProvider, useMutation } from "@tanstack/react-query";
import React from "react";
import { queryKeys } from "@mini-infra/types";
import { ApiRequestError } from "@/lib/api-client";
import {
  createQueryClient,
  defaultQueryRetry,
  defaultQueryRetryDelay,
  resetAuthRedirectLatch,
} from "@/lib/query-client";

const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

describe("defaultQueryRetry", () => {
  it("never retries a 4xx ApiRequestError", () => {
    const badRequest = new ApiRequestError(400, "BAD_REQUEST", "bad request");
    const unauthorized = new ApiRequestError(401, "UNAUTHORIZED", "no session");
    const notFound = new ApiRequestError(404, "NOT_FOUND", "missing");
    const tooMany = new ApiRequestError(429, "RATE_LIMITED", "slow down");

    for (const error of [badRequest, unauthorized, notFound, tooMany]) {
      expect(defaultQueryRetry(0, error)).toBe(false);
    }
  });

  it("retries a client-side network/timeout failure (status 0) up to the cap", () => {
    const timeout = new ApiRequestError(0, "TIMEOUT", "timed out");

    expect(defaultQueryRetry(0, timeout)).toBe(true);
    expect(defaultQueryRetry(1, timeout)).toBe(true);
    expect(defaultQueryRetry(2, timeout)).toBe(true);
    expect(defaultQueryRetry(3, timeout)).toBe(false);
  });

  it("retries a 5xx ApiRequestError up to the cap", () => {
    const serverError = new ApiRequestError(503, "UNAVAILABLE", "down for maintenance");

    expect(defaultQueryRetry(0, serverError)).toBe(true);
    expect(defaultQueryRetry(2, serverError)).toBe(true);
    expect(defaultQueryRetry(3, serverError)).toBe(false);
  });

  it("retries a non-ApiRequestError failure up to the cap (defensive default)", () => {
    const genericError = new Error("boom");

    expect(defaultQueryRetry(0, genericError)).toBe(true);
    expect(defaultQueryRetry(3, genericError)).toBe(false);
  });
});

describe("defaultQueryRetryDelay", () => {
  it("backs off exponentially, capped at 30s", () => {
    expect(defaultQueryRetryDelay(0)).toBe(1000);
    expect(defaultQueryRetryDelay(1)).toBe(2000);
    expect(defaultQueryRetryDelay(2)).toBe(4000);
    expect(defaultQueryRetryDelay(10)).toBe(30000);
  });
});

describe("createQueryClient 401 handling", () => {
  beforeEach(() => {
    resetAuthRedirectLatch();
  });

  it("marks the cached auth status unauthenticated exactly once when two queries fail with 401 concurrently", async () => {
    const client = createQueryClient();

    const unauthorized = () =>
      Promise.reject(new ApiRequestError(401, "UNAUTHORIZED", "session expired"));

    // Seed an "authenticated" auth-status value, as the real app would have
    // after login, so we can observe it flip.
    client.setQueryData(queryKeys.auth.status, {
      isAuthenticated: true,
      user: { id: "1", email: "a@b.com" },
    });

    const setQueryDataSpy = vi.spyOn(client, "setQueryData");
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    // Two "simultaneous" 401s — e.g. two widgets both mid-fetch when the
    // session expires — dispatched together via Promise.allSettled so
    // both queries' failures land on the QueryCache around the same time.
    await Promise.allSettled([
      client.fetchQuery({
        queryKey: ["test-widget-a"],
        queryFn: unauthorized,
        retry: false,
      }),
      client.fetchQuery({
        queryKey: ["test-widget-b"],
        queryFn: unauthorized,
        retry: false,
      }),
    ]);

    expect(setQueryDataSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(queryKeys.auth.status)).toEqual({
      isAuthenticated: false,
      user: null,
    });

    client.clear();
  });

  it("a 401 from a mutation also triggers the same handler", async () => {
    const client = createQueryClient();

    client.setQueryData(queryKeys.auth.status, {
      isAuthenticated: true,
      user: { id: "1", email: "a@b.com" },
    });

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: () =>
            Promise.reject(new ApiRequestError(401, "UNAUTHORIZED", "session expired")),
        }),
      { wrapper },
    );

    await act(async () => {
      // The mutation itself still rejects for its own caller — only the
      // global 401 side effect (marking auth-status unauthenticated) is
      // under test here.
      await result.current.mutateAsync(undefined).catch(() => {});
    });

    expect(client.getQueryData(queryKeys.auth.status)).toEqual({
      isAuthenticated: false,
      user: null,
    });

    client.clear();
  });

  it("does not touch the auth-status cache for a non-401 error", async () => {
    const client = createQueryClient();

    client.setQueryData(queryKeys.auth.status, {
      isAuthenticated: true,
      user: { id: "1", email: "a@b.com" },
    });

    await client
      .fetchQuery({
        queryKey: ["test-widget-c"],
        queryFn: () =>
          Promise.reject(new ApiRequestError(500, "SERVER_ERROR", "boom")),
        retry: false,
      })
      .catch(() => {
        // expected
      });

    expect(client.getQueryData(queryKeys.auth.status)).toEqual({
      isAuthenticated: true,
      user: { id: "1", email: "a@b.com" },
    });

    client.clear();
  });

  it("can trigger the handler again after the latch is reset (re-authenticated, then session expires again)", async () => {
    const client = createQueryClient();

    const unauthorized = () =>
      Promise.reject(new ApiRequestError(401, "UNAUTHORIZED", "session expired"));

    await client
      .fetchQuery({ queryKey: ["test-widget-d"], queryFn: unauthorized, retry: false })
      .catch(() => {});
    expect(client.getQueryData(queryKeys.auth.status)).toEqual({
      isAuthenticated: false,
      user: null,
    });

    // Simulate the user logging back in (auth-context.tsx calls this once
    // `useAuthStatus` reports an authenticated session again).
    resetAuthRedirectLatch();
    client.setQueryData(queryKeys.auth.status, {
      isAuthenticated: true,
      user: { id: "1", email: "a@b.com" },
    });

    await client
      .fetchQuery({ queryKey: ["test-widget-e"], queryFn: unauthorized, retry: false })
      .catch(() => {});
    expect(client.getQueryData(queryKeys.auth.status)).toEqual({
      isAuthenticated: false,
      user: null,
    });

    client.clear();
  });
});

describe("createQueryClient mutation error toasting (error-handling-overhaul Phase 2)", () => {
  beforeEach(() => {
    resetAuthRedirectLatch();
    toastErrorMock.mockClear();
  });

  function wrapperFor(client: ReturnType<typeof createQueryClient>) {
    return ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
  }

  it("toasts a non-401 mutation error via the default MutationCache.onError", async () => {
    const client = createQueryClient();
    const conflict = new ApiRequestError(409, "CONFLICT", "already exists");

    const { result } = renderHook(
      () => useMutation({ mutationFn: () => Promise.reject(conflict) }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      await result.current.mutateAsync(undefined).catch(() => {});
    });

    expect(toastErrorMock).toHaveBeenCalledOnce();
    client.clear();
  });

  it("does NOT toast when the mutation opts out via meta.skipErrorToast", async () => {
    const client = createQueryClient();
    const conflict = new ApiRequestError(409, "CONFLICT", "already exists");

    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: () => Promise.reject(conflict),
          meta: { skipErrorToast: true },
        }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      await result.current.mutateAsync(undefined).catch(() => {});
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
    client.clear();
  });

  it("does NOT toast a 401 — it still only redirects via handleUnauthorized", async () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.auth.status, {
      isAuthenticated: true,
      user: { id: "1", email: "a@b.com" },
    });
    const unauthorized = new ApiRequestError(401, "UNAUTHORIZED", "session expired");

    const { result } = renderHook(
      () => useMutation({ mutationFn: () => Promise.reject(unauthorized) }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      await result.current.mutateAsync(undefined).catch(() => {});
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.auth.status)).toEqual({
      isAuthenticated: false,
      user: null,
    });

    client.clear();
  });
});
