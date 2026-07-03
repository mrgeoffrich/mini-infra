/**
 * Typed HTTP client for talking to the Mini Infra API.
 *
 * `apiFetch<T>()` is the single shared primitive for making a request: it
 * attaches credentials + the standard headers (Content-Type, correlation
 * ID), enforces a request timeout, throws a typed `ApiRequestError` on any
 * non-2xx response (or on an envelope with `success: false`), and unwraps
 * the `{ success, data }` envelope so callers get back `T` directly.
 *
 * This is Phase 1 of the frontend/backend contract migration
 * (docs/planning/not-shipped/frontend-backend-contract-plan.md) — only the
 * `useContainers` hook has been migrated onto it so far. Other hooks keep
 * their existing raw-`fetch` skeletons until Phase 4.
 */

import { HttpHeader, newCorrelationId } from "@mini-infra/types";
import type { ApiResponse } from "@mini-infra/types";

/** Default request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiFetchOptions {
  /** HTTP method. Defaults to "GET". */
  method?: HttpMethod;
  /** Request body. Non-string objects are JSON-stringified automatically. */
  body?: unknown;
  /** Extra headers to send. Merged over (and can override) the defaults. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Prefix used when generating the `X-Correlation-ID` header, so server
   * logs can still be grouped by calling resource (e.g. "containers").
   * Defaults to "req".
   */
  correlationIdPrefix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Best-effort JSON parse — returns undefined rather than throwing on empty/invalid bodies. */
async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function extractMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.message === "string" && body.message.length > 0) {
    return body.message;
  }
  return fallback;
}

function extractCode(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.error === "string" && body.error.length > 0) {
    return body.error;
  }
  return fallback;
}

/**
 * Thrown by `apiFetch` on any non-2xx HTTP response, or on a 2xx response
 * whose envelope has `success: false`. Named `ApiRequestError` (rather than
 * the plan sketch's generic `ApiError`) to avoid colliding with the
 * existing `ApiError` JSON-error-body type in `@mini-infra/types`.
 */
export class ApiRequestError extends Error {
  /** HTTP status code. 0 for client-side failures (e.g. a timeout) that never got a response. */
  readonly status: number;
  /** Machine-readable error code — the server's `error` field, or a synthesized fallback. */
  readonly code: string;
  /** Best-effort parsed response/error body, if any. */
  readonly body?: unknown;

  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** True when the request failed because the session is unauthenticated/expired. */
  get isAuth(): boolean {
    return this.status === 401;
  }

  /** True when the failure was a server-side error (5xx). */
  get isServer(): boolean {
    return this.status >= 500;
  }
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

/**
 * Fetch `path` and return the unwrapped `data` from the server's
 * `{ success, data }` envelope. Throws `ApiRequestError` on any non-2xx
 * response, on a timeout, or when the envelope reports `success: false`.
 */
export async function apiFetch<T>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const {
    method = "GET",
    body,
    headers,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    correlationIdPrefix = "req",
  } = opts;

  const requestHeaders: Record<string, string> = {
    [HttpHeader.ContentType]: "application/json",
    [HttpHeader.CorrelationId]: newCorrelationId(correlationIdPrefix),
    ...headers,
  };

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "include",
      headers: requestHeaders,
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new ApiRequestError(
        0,
        "TIMEOUT",
        `Request to ${path} timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  }

  if (!response.ok) {
    const errorBody = await parseJsonSafe(response);
    throw new ApiRequestError(
      response.status,
      extractCode(errorBody, `HTTP_${response.status}`),
      extractMessage(
        errorBody,
        response.statusText || `Request failed with status ${response.status}`,
      ),
      errorBody,
    );
  }

  // No content to parse (e.g. 204 from a DELETE).
  if (response.status === 204) {
    return undefined as T;
  }

  const envelope = (await parseJsonSafe(response)) as ApiResponse<T> | undefined;

  if (envelope && envelope.success === false) {
    throw new ApiRequestError(
      response.status,
      extractCode(envelope, "REQUEST_FAILED"),
      extractMessage(envelope, "Request failed"),
      envelope,
    );
  }

  return envelope?.data as T;
}
