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

export interface HttpResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
}

// ---------------------------------------------------------------------------
// HttpError — replaces AxiosError
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  readonly isHttpError = true as const;
  response?: { status: number; data: any };
  code?: string;
  config?: { url?: string };

  constructor(
    message: string,
    opts?: {
      response?: { status: number; data: any };
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
      (error as any).isHttpError === true)
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

  async get<T = any>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('GET', url, undefined, config);
  }

  async post<T = any>(url: string, body?: any, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('POST', url, body, config);
  }

  async put<T = any>(url: string, body?: any, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', url, body, config);
  }

  async delete<T = any>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', url, undefined, config);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async request<T>(
    method: string,
    url: string,
    body?: any,
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
        fetchBody = body as any;
        // Don't override Content-Type if already set (e.g. for multipart/form-data or text/plain)
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      } else if (typeof body === 'object' && body !== null && typeof body.getHeaders === 'function') {
        // FormData from 'form-data' package — let it set its own Content-Type with boundary
        fetchBody = body.getBuffer();
        const formHeaders = body.getHeaders();
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
    } catch (err: any) {
      // Map network errors to HttpError with codes matching the old axios patterns
      const code = this.mapFetchErrorCode(err);
      throw new HttpError(err.message ?? 'Network error', {
        code,
        url: fullUrl,
      });
    }

    // Parse response body
    let data: any;
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
      const message = typeof data === 'object' && data?.message
        ? data.message
        : `Request failed with status code ${response.status}`;
      throw new HttpError(message, {
        response: { status: response.status, data },
        url: fullUrl,
      });
    }

    return { data, status: response.status, statusText: response.statusText };
  }

  private buildUrl(url: string, params?: Record<string, string>): string {
    let base = this.defaults.baseURL;
    // If url is already absolute, use it directly
    const absolute = url.startsWith('http://') || url.startsWith('https://');
    const full = absolute ? url : `${base}${url}`;

    if (!params || Object.keys(params).length === 0) return full;

    const sep = full.includes('?') ? '&' : '?';
    const qs = new URLSearchParams(params).toString();
    return `${full}${sep}${qs}`;
  }

  private mapFetchErrorCode(err: any): string {
    const msg = (err.message ?? '').toLowerCase();
    const cause = err.cause;
    const causeCode: string | undefined = cause?.code;

    if (causeCode === 'ECONNREFUSED' || msg.includes('econnrefused')) return 'ECONNREFUSED';
    if (causeCode === 'ENOTFOUND' || msg.includes('enotfound')) return 'ENOTFOUND';
    if (causeCode === 'ECONNRESET' || msg.includes('econnreset')) return 'ECONNRESET';
    if (causeCode === 'ETIMEDOUT' || msg.includes('etimedout')) return 'ETIMEDOUT';
    if (err.name === 'TimeoutError' || msg.includes('timed out') || msg.includes('timeout')) return 'ETIMEDOUT';
    if (err.name === 'AbortError') return 'ETIMEDOUT';
    return causeCode ?? 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Factory (replaces axios.create())
// ---------------------------------------------------------------------------

export function createHttpClient(config?: HttpClientConfig): HttpClient {
  return new HttpClient(config);
}
