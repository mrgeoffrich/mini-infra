// Thin fetch() wrapper for the Mini Infra REST API.
//
// Mirrors the behaviour of the bash seeder's api() helper:
//   - Returns { status, body, bodyText }.
//   - Network failure is reported as status: 0 (bash uses "000").
//   - Adds Authorization: Bearer <apiKey> automatically once setApiKey() is called.

export interface ApiResponse<T = unknown> {
  status: number;
  body: T | null;
  bodyText: string;
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

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      return {
        status: 0,
        body: null,
        bodyText: err instanceof Error ? err.message : String(err),
      };
    }

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
