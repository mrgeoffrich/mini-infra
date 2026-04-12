/**
 * Lightweight HTTP client built on native fetch, replacing axios.
 *
 * Provides:
 *  - Instance creation with baseURL, default headers, basic auth, timeout
 *  - get / post / put / delete methods returning { data, status }
 *  - HttpError class with response details for error handling
 *  - isHttpError() type guard (replaces axios.isAxiosError())
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpClientConfig {
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
  auth?: { username: string; password: string };
}

export interface HttpRequestConfig {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  /** When true, don't throw on non-2xx status codes */
  validateStatus?: (status: number) => boolean;
  /** Timeout in ms — overrides instance default */
  timeout?: number;
}

export interface HttpResponse<T = HttpResponseData> {
  data: T;
  status: number;
  statusText: string;
}

/**
 * Default fallback for HttpResponse<T>.data — callers that don't specify a generic
 * type receive a value they can index arbitrarily. Kept as `any` for backward
 * compatibility with many existing haproxy/cloudflare callers; narrow via an
 * explicit generic argument (e.g. `httpClient.get<MyShape>(...)`) for new code.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HttpResponseData = any;

// ---------------------------------------------------------------------------
// HttpError — replaces AxiosError
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  readonly isHttpError = true as const;
  response?: { status: number; data: HttpResponseData };
  code?: string;
  config?: { url?: string };

  constructor(
    message: string,
    opts?: {
      response?: { status: number; data: HttpResponseData };
      code?: string;
      url?: string;
    },
  ) {
    super(message);
    this.name = 'HttpError';
    this.response = opts?.response;
    this.code = opts?.code;
    this.config = opts?.url ? { url: opts.url } : undefined;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return (
    error instanceof HttpError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { isHttpError?: unknown }).isHttpError === true)
  );
}

// ---------------------------------------------------------------------------
// HttpClient
// ---------------------------------------------------------------------------

export class HttpClient {
  defaults: {
    baseURL: string;
    timeout: number;
    headers: Record<string, string>;
    auth?: { username: string; password: string };
  };

  constructor(config: HttpClientConfig = {}) {
    this.defaults = {
      baseURL: config.baseURL ?? '',
      timeout: config.timeout ?? 10_000,
      headers: { ...config.headers },
      auth: config.auth,
    };
  }

  // -----------------------------------------------------------------------
  // Public HTTP methods
  // -----------------------------------------------------------------------

  async get<T = HttpResponseData>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('GET', url, undefined, config);
  }

  async post<T = HttpResponseData>(url: string, body?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('POST', url, body, config);
  }

  async put<T = HttpResponseData>(url: string, body?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', url, body, config);
  }

  async head<T = HttpResponseData>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('HEAD', url, undefined, config);
  }

  async delete<T = HttpResponseData>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', url, undefined, config);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
    config?: HttpRequestConfig,
  ): Promise<HttpResponse<T>> {
    const fullUrl = this.buildUrl(url, config?.params);
    const timeout = config?.timeout ?? this.defaults.timeout;

    const headers: Record<string, string> = {
      ...this.defaults.headers,
      ...config?.headers,
    };

    // Basic auth
    if (this.defaults.auth) {
      const { username, password } = this.defaults.auth;
      headers['Authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    // Body handling
    let fetchBody: BodyInit | undefined;
    if (body !== undefined) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        fetchBody = body as BodyInit;
        // Don't override Content-Type if already set (e.g. for multipart/form-data or text/plain)
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      } else if (
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { getHeaders?: unknown }).getHeaders === 'function'
      ) {
        // FormData from 'form-data' package — let it set its own Content-Type with boundary
        const formBody = body as {
          getBuffer: () => Buffer;
          getHeaders: () => Record<string, string>;
        };
        fetchBody = new Uint8Array(formBody.getBuffer());
        const formHeaders = formBody.getHeaders();
        // Remove any existing Content-Type (case-insensitive) before applying FormData headers
        delete headers['Content-Type'];
        delete headers['content-type'];
        Object.assign(headers, formHeaders);
      } else {
        fetchBody = JSON.stringify(body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    let response: Response;
    try {
      response = await fetch(fullUrl, {
        method,
        headers,
        body: fetchBody,
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
    } catch (err: unknown) {
      // Map network errors to HttpError with codes matching the old axios patterns
      const code = this.mapFetchErrorCode(err);
      const message = err instanceof Error ? err.message : 'Network error';
      throw new HttpError(message, {
        code,
        url: fullUrl,
      });
    }

    // Parse response body
    let data: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      // Try JSON parse for responses that don't set content-type properly
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    // Custom validateStatus or default: throw on non-2xx
    const shouldThrow = config?.validateStatus
      ? !config.validateStatus(response.status)
      : response.status < 200 || response.status >= 300;

    if (shouldThrow) {
      const dataMessage =
        typeof data === 'object' && data !== null && 'message' in data
          ? (data as { message?: unknown }).message
          : undefined;
      const message =
        typeof dataMessage === 'string'
          ? dataMessage
          : `Request failed with status code ${response.status}`;
      throw new HttpError(message, {
        response: { status: response.status, data },
        url: fullUrl,
      });
    }

    return { data: data as T, status: response.status, statusText: response.statusText };
  }

  private buildUrl(url: string, params?: Record<string, string>): string {
    const base = this.defaults.baseURL;
    // If url is already absolute, use it directly
    const absolute = url.startsWith('http://') || url.startsWith('https://');
    const full = absolute ? url : `${base}${url}`;

    if (!params || Object.keys(params).length === 0) return full;

    const sep = full.includes('?') ? '&' : '?';
    const qs = new URLSearchParams(params).toString();
    return `${full}${sep}${qs}`;
  }

  private mapFetchErrorCode(err: unknown): string {
    const errRecord = (err ?? {}) as { message?: unknown; cause?: unknown; name?: unknown };
    const msg = (typeof errRecord.message === 'string' ? errRecord.message : '').toLowerCase();
    const cause = errRecord.cause as { code?: unknown } | undefined;
    const causeCode = typeof cause?.code === 'string' ? cause.code : undefined;
    const name = typeof errRecord.name === 'string' ? errRecord.name : '';

    if (causeCode === 'ECONNREFUSED' || msg.includes('econnrefused')) return 'ECONNREFUSED';
    if (causeCode === 'ENOTFOUND' || msg.includes('enotfound')) return 'ENOTFOUND';
    if (causeCode === 'ECONNRESET' || msg.includes('econnreset')) return 'ECONNRESET';
    if (causeCode === 'ETIMEDOUT' || msg.includes('etimedout')) return 'ETIMEDOUT';
    if (name === 'TimeoutError' || msg.includes('timed out') || msg.includes('timeout')) return 'ETIMEDOUT';
    if (name === 'AbortError') return 'ETIMEDOUT';
    return causeCode ?? 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Factory (replaces axios.create())
// ---------------------------------------------------------------------------

export function createHttpClient(config?: HttpClientConfig): HttpClient {
  return new HttpClient(config);
}
