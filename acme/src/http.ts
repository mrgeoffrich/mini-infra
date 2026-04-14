import { JwsSigner } from "./jws";
import { AcmeProblem, AcmeProblemError } from "./errors";
import { Directory } from "./types";

export interface AcmeResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
  location?: string;
  retryAfterSeconds?: number;
}

const readHeaders = (res: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
};

export const parseRetryAfter = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const sec = parseInt(value, 10);
  if (Number.isSafeInteger(sec) && sec > 0) return sec;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const diff = Math.ceil((date.getTime() - Date.now()) / 1000);
    if (diff > 0) return diff;
  }
  return undefined;
};

const parseBody = async (res: Response): Promise<unknown> => {
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json") || type.includes("problem+json")) {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  return res.text();
};

const isProblemJson = (headers: Record<string, string>, body: unknown): body is AcmeProblem =>
  typeof body === "object" && body !== null && (headers["content-type"] ?? "").includes("problem+json");

export interface AcmeHttpClientOptions {
  directoryUrl: string;
  signer: JwsSigner;
  fetchImpl?: typeof fetch;
  maxBadNonceRetries?: number;
  directoryMaxAgeMs?: number;
}

export class AcmeHttpClient {
  private readonly directoryUrl: string;
  private readonly signer: JwsSigner;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBadNonceRetries: number;
  private readonly directoryMaxAgeMs: number;

  private directoryCache: Directory | null = null;
  private directoryFetchedAt = 0;
  private nonce: string | null = null;

  constructor(opts: AcmeHttpClientOptions) {
    this.directoryUrl = opts.directoryUrl;
    this.signer = opts.signer;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxBadNonceRetries = opts.maxBadNonceRetries ?? 5;
    this.directoryMaxAgeMs = opts.directoryMaxAgeMs ?? 86_400_000;
  }

  get jwk() {
    return this.signer.jwk;
  }

  async getDirectory(): Promise<Directory> {
    const age = Date.now() - this.directoryFetchedAt;
    if (!this.directoryCache || age > this.directoryMaxAgeMs) {
      const res = await this.fetchImpl(this.directoryUrl, { method: "GET" });
      const headers = readHeaders(res);
      const data = (await parseBody(res)) as Directory | AcmeProblem;
      if (res.status >= 400 || !data) {
        throw new AcmeProblemError(
          isProblemJson(headers, data) ? data : { detail: `Failed to fetch ACME directory (status ${res.status})` }
        );
      }
      this.directoryCache = data as Directory;
      this.directoryFetchedAt = Date.now();
    }
    return this.directoryCache;
  }

  async getResourceUrl(name: keyof Directory | string): Promise<string> {
    const dir = await this.getDirectory();
    const url = (dir as unknown as Record<string, unknown>)[name as string];
    if (typeof url !== "string") {
      throw new Error(`ACME directory missing resource: ${String(name)}`);
    }
    return url;
  }

  async getMetaField(field: string): Promise<string | null> {
    const dir = await this.getDirectory();
    const meta = dir.meta as Record<string, unknown> | undefined;
    const value = meta?.[field];
    return typeof value === "string" ? value : null;
  }

  private updateNonce(headers: Record<string, string>) {
    const replay = headers["replay-nonce"];
    if (replay) this.nonce = replay;
  }

  async getNonce(): Promise<string> {
    if (this.nonce) {
      const cached = this.nonce;
      this.nonce = null;
      return cached;
    }
    const url = await this.getResourceUrl("newNonce");
    const res = await this.fetchImpl(url, { method: "HEAD" });
    const headers = readHeaders(res);
    const nonce = headers["replay-nonce"];
    if (!nonce) {
      throw new Error("Failed to obtain Replay-Nonce from ACME provider");
    }
    return nonce;
  }

  async rawGet<T = unknown>(url: string): Promise<AcmeResponse<T>> {
    const res = await this.fetchImpl(url, { method: "GET" });
    const headers = readHeaders(res);
    this.updateNonce(headers);
    const data = (await parseBody(res)) as T;
    return {
      status: res.status,
      headers,
      data,
      location: headers["location"],
      retryAfterSeconds: parseRetryAfter(headers["retry-after"]),
    };
  }

  async signedRequest<T = unknown>(
    url: string,
    payload: unknown,
    opts: { kid?: string | null } = {}
  ): Promise<AcmeResponse<T>> {
    let attempts = 0;
    for (;;) {
      const nonce = await this.getNonce();
      const body = this.signer.createSignedBody({
        url,
        nonce,
        kid: opts.kid ?? null,
        payload,
      });
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/jose+json" },
        body: JSON.stringify(body),
      });
      const headers = readHeaders(res);
      this.updateNonce(headers);
      const data = (await parseBody(res)) as T;

      if (res.status === 400 && isProblemJson(headers, data)) {
        if (data.type === "urn:ietf:params:acme:error:badNonce" && attempts < this.maxBadNonceRetries) {
          attempts += 1;
          continue;
        }
      }

      if (res.status >= 400) {
        const problem: AcmeProblem = isProblemJson(headers, data) ? (data as AcmeProblem) : { detail: `HTTP ${res.status}` };
        throw new AcmeProblemError(problem);
      }

      return {
        status: res.status,
        headers,
        data,
        location: headers["location"],
        retryAfterSeconds: parseRetryAfter(headers["retry-after"]),
      };
    }
  }
}
