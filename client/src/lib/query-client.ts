/**
 * Factory for the single shared TanStack Query `QueryClient`.
 *
 * Phase 5 of docs/planning/not-shipped/frontend-backend-contract-plan.md
 * centralizes two behaviors that were previously missing entirely:
 *
 *  1. A typed default retry policy (`defaultQueryRetry` /
 *     `defaultQueryRetryDelay`), generalizing the per-hook pattern already
 *     used in `useContainers.ts`: never retry a 4xx `ApiRequestError` (the
 *     request can't succeed by repeating it unchanged), retry a
 *     client-side network/timeout failure (`status === 0`) or a 5xx up to
 *     a small cap with exponential backoff. TanStack Query only falls back
 *     to `defaultOptions.queries.retry` when a query doesn't set its own
 *     `retry` — so every hook's existing per-hook override still wins.
 *
 *  2. One `QueryCache` + `MutationCache` `onError`, shared by every query
 *     and mutation, that reacts to a 401 (`ApiRequestError.isAuth`) by
 *     marking the session unauthenticated through the EXISTING auth-status
 *     pathway rather than a parallel one — see `handleUnauthorized` below.
 *     `ProtectedRoute` already redirects to /login whenever
 *     `useAuthStatus()` reports `isAuthenticated: false` (see
 *     `client/src/components/protected-route.tsx`), so updating that one
 *     cached value is enough to trigger a normal SPA redirect. No
 *     `window.location` reload, no second auth mechanism.
 *
 *  3. Phase 2 of docs/planning/not-shipped/error-handling-overhaul-plan.md
 *     (§4.4 "Global wiring") extends the `MutationCache.onError` above with
 *     a global default: any mutation error that isn't a 401 gets an
 *     actionable toast via `toastApiError()` (`client/src/lib/errors.ts`).
 *     A call site opts out with `useMutation({ meta: { skipErrorToast: true } })`
 *     when it renders the error inline or handles it bespoke — see
 *     `client/ARCHITECTURE.md`'s error-handling section. `QueryCache` is
 *     deliberately left alone; only mutations get the default toast.
 *
 * Exported as a factory (rather than a singleton instance) so tests can
 * construct an isolated client per test case; `auth-context.tsx` calls this
 * once at module scope for the real app, exactly as it constructed its own
 * `QueryClient` inline before this phase.
 */

import { QueryCache, QueryClient, MutationCache } from "@tanstack/react-query";
import { queryKeys } from "@mini-infra/types";
import type { AuthStatus } from "./auth-types";
import { ApiRequestError } from "./api-client";
import { toastApiError } from "./errors";

// ====================
// Retry policy
// ====================

const MAX_RETRY_COUNT = 3;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Typed default retry policy. Never retries a 4xx `ApiRequestError` (bad
 * request, forbidden, not found, unauthenticated, validation, etc. — all
 * unwinnable by repeating the same request). Retries anything else
 * (a client-side network/timeout failure with `status === 0`, a 5xx, or a
 * non-`ApiRequestError` failure) up to `MAX_RETRY_COUNT` times, same as the
 * `useContainers.ts` reference pattern.
 */
export function defaultQueryRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRY_COUNT;
}

/** Exponential backoff capped at `MAX_RETRY_DELAY_MS` — mirrors `useContainers.ts`. */
export function defaultQueryRetryDelay(attemptIndex: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** attemptIndex, MAX_RETRY_DELAY_MS);
}

// ====================
// Global 401 handling
// ====================

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.isAuth;
}

/**
 * Guards `handleUnauthorized` so that many queries/mutations failing with
 * 401 around the same moment (e.g. a session expiring mid-page, where
 * several widgets are all mid-fetch) trigger exactly ONE auth-status
 * invalidation/redirect instead of one each. A module-level flag rather
 * than React state because the `QueryCache`/`MutationCache` callbacks run
 * outside the React tree (the `QueryClient` is constructed before
 * `AuthProvider` mounts). Reset back to `false` once the app observes an
 * authenticated session again — see the effect in `auth-context.tsx`.
 */
let authRedirectLatch = false;

/**
 * Called once `useAuthStatus` reports an authenticated session again (see
 * `auth-context.tsx`), so a *future* 401 can trigger the redirect again.
 * Also used by tests to reset state between cases.
 */
export function resetAuthRedirectLatch(): void {
  authRedirectLatch = false;
}

function handleUnauthorized(client: QueryClient): void {
  if (authRedirectLatch) {
    return;
  }
  authRedirectLatch = true;

  // Mark the cached auth status unauthenticated immediately (no network
  // round-trip) so `ProtectedRoute` redirects to /login on its very next
  // render, via the exact same mechanism a normal auth-status poll uses.
  client.setQueryData<AuthStatus>(queryKeys.auth.status, {
    isAuthenticated: false,
    user: null,
  });

  // Also invalidate so the query reconciles with the server the next time
  // it's observed/refetched (e.g. after the user logs back in).
  void client.invalidateQueries({ queryKey: queryKeys.auth.status });
}

/** Builds the app's single `QueryClient`, wired with the retry policy and 401 handling above. */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isUnauthorizedError(error)) {
          handleUnauthorized(client);
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (isUnauthorizedError(error)) {
          handleUnauthorized(client);
          return;
        }
        // Opt-out for sites that render the error inline or handle it
        // bespoke (e.g. keeping a dialog open with a field-level message)
        // instead of the default toast — see §4.4 of the error-handling
        // overhaul plan.
        if (mutation.meta?.skipErrorToast === true) {
          return;
        }
        // Opt-in application-context wording: a mutation fired from an
        // application screen sets `meta: { errorContext: 'application' }` so
        // stack-vocabulary server errors render with "application" copy.
        const context =
          mutation.meta?.errorContext === "application" ? "application" : undefined;
        toastApiError(error, { context });
      },
    }),
    defaultOptions: {
      queries: {
        retry: defaultQueryRetry,
        retryDelay: defaultQueryRetryDelay,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        staleTime: 1 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
      },
      // Mutations intentionally keep TanStack Query's own default (no
      // retry) — only a mutation that already opts in to `retry` gets one.
    },
  });

  return client;
}
