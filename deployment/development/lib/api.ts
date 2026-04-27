// Thin fetch() wrapper for the Mini Infra REST API.
//
// Mirrors the behaviour of the bash seeder's api() helper:
//   - Returns { status, body, bodyText }.
//   - Network failure is reported as status: 0 (bash uses "000").
//   - Adds Authorization: Bearer <apiKey> automatically once setApiKey() is called.
//   - Retries on socket-level failures (status: 0) only. HTTP responses pass
//     through untouched so 4xx/5xx still surface to the caller verbatim.

export interface ApiResponse<T = unknown> {
  status: number;
  body: T | null;
  bodyText: string;
}

// Retry only when fetch() itself throws. Backoff is short — the typical cause is
// a stale keep-alive socket against a freshly restarted server (the setup
// wizard restarts the app to load the Docker config), and a 250ms delay is
// enough for the next request to open a fresh TCP connection.
const NETWORK_RETRY_DELAYS_MS = [250, 750, 1500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ApiClient {
  private apiKey: string | undefined;

  constructor(
    private readonly baseUrl: string,
    apiKey?: string,
  ) {
    this.apiKey = apiKey;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  get<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    // Disable keep-alive to avoid undici reusing a TCP connection the server
    // has already torn down (notably right after /auth/setup/complete restarts
    // the app). Cheap enough — the seeder makes ~30 requests total.
    headers.Connection = 'close';

    const init: RequestInit = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await fetch(url, init);
        const bodyText = await res.text();
        let parsed: T | null = null;
        if (bodyText.length) {
          try {
            parsed = JSON.parse(bodyText) as T;
          } catch {
            parsed = null;
          }
        }
        return { status: res.status, body: parsed, bodyText };
      } catch (err) {
        lastError = err;
        const delay = NETWORK_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await sleep(delay);
      }
    }

    return {
      status: 0,
      body: null,
      bodyText: lastError instanceof Error ? lastError.message : String(lastError),
    };
  }
}

export function pickItems<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as T[];
    if (Array.isArray(record.environments)) return record.environments as T[];
    if (Array.isArray(record.templates)) return record.templates as T[];
  }
  return [];
}

export function pickObject<T>(body: unknown): T | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (record.data && typeof record.data === 'object') return record.data as T;
    return body as T;
  }
  return null;
}
