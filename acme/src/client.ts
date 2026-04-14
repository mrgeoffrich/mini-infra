import { createHash } from "node:crypto";
import { AcmeHttpClient } from "./http";
import { JwsSigner } from "./jws";
import { jwkThumbprint } from "./crypto/jwk";
import { pemToDer, derToB64u } from "./crypto/pem";
import { AcmeProblemError } from "./errors";
import { auto, AutoOptions } from "./flow/auto";
import { retryWithBackoff } from "./flow/poll";
import { Account, Authorization, Challenge, Identifier, Order } from "./types";

export interface AcmeClientOptions {
  directoryUrl: string;
  accountKey: Buffer | string;
  accountUrl?: string | null;
  backoffAttempts?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  fetchImpl?: typeof fetch;
}

const terminalOrderStates = new Set(["ready", "valid"]);
const pendingOrderStates = new Set(["pending", "processing"]);
const invalidStates = new Set(["invalid"]);

export class AcmeClient {
  readonly http: AcmeHttpClient;
  private readonly signer: JwsSigner;
  private accountUrl: string | null;
  private readonly backoffAttempts: number;
  private readonly backoffMin: number;
  private readonly backoffMax: number;

  constructor(opts: AcmeClientOptions) {
    this.signer = new JwsSigner(opts.accountKey);
    this.http = new AcmeHttpClient({
      directoryUrl: opts.directoryUrl,
      signer: this.signer,
      fetchImpl: opts.fetchImpl,
    });
    this.accountUrl = opts.accountUrl ?? null;
    this.backoffAttempts = opts.backoffAttempts ?? 10;
    this.backoffMin = opts.backoffMinMs ?? 5_000;
    this.backoffMax = opts.backoffMaxMs ?? 30_000;
  }

  hasAccount(): boolean {
    return Boolean(this.accountUrl);
  }

  getAccountUrl(): string {
    if (!this.accountUrl) throw new Error("No account URL, register an account first");
    return this.accountUrl;
  }

  async getTermsOfServiceUrl(): Promise<string | null> {
    return this.http.getMetaField("termsOfService");
  }

  async createAccount(data: { termsOfServiceAgreed: boolean; contact?: string[]; onlyReturnExisting?: boolean } = { termsOfServiceAgreed: false }): Promise<Account> {
    const url = await this.http.getResourceUrl("newAccount");
    const resp = await this.http.signedRequest<Account>(url, data);
    if (!resp.location) {
      throw new Error("ACME newAccount response missing Location header");
    }
    this.accountUrl = resp.location;
    const tos = await this.http.getMetaField("termsOfService");
    return { ...(resp.data as Account), url: resp.location, termsOfService: tos ?? undefined };
  }

  async createOrder(identifiers: Identifier[]): Promise<Order> {
    const url = await this.http.getResourceUrl("newOrder");
    const resp = await this.http.signedRequest<Order>(url, { identifiers }, { kid: this.getAccountUrl() });
    if (!resp.location) {
      throw new Error("ACME newOrder response missing Location header");
    }
    return { ...(resp.data as Order), url: resp.location };
  }

  async getAuthorizations(order: Order): Promise<Authorization[]> {
    return Promise.all(
      order.authorizations.map(async (url) => {
        const resp = await this.http.signedRequest<Authorization>(url, null, { kid: this.getAccountUrl() });
        return { ...(resp.data as Authorization), url };
      })
    );
  }

  getChallengeKeyAuthorization(challenge: Challenge): string {
    const thumbprint = jwkThumbprint(this.signer.jwk);
    const base = `${challenge.token}.${thumbprint}`;
    if (challenge.type === "dns-01") {
      return createHash("sha256").update(base).digest("base64url");
    }
    return base;
  }

  async completeChallenge(challenge: Challenge): Promise<Challenge> {
    const resp = await this.http.signedRequest<Challenge>(challenge.url, {}, { kid: this.getAccountUrl() });
    return resp.data as Challenge;
  }

  async waitForValidStatus<T extends { status: string; error?: unknown }>(url: string): Promise<T> {
    return retryWithBackoff(
      async (ctx) => {
        const resp = await this.http.signedRequest<T>(url, null, { kid: this.getAccountUrl() });
        const status = resp.data?.status;
        if (!status) throw new Error(`Response from ${url} missing status field`);

        if (invalidStates.has(status)) {
          ctx.abort();
          const err = resp.data?.error as { detail?: string; type?: string } | undefined;
          throw new AcmeProblemError({
            type: err?.type,
            detail: err?.detail ?? `ACME resource reached invalid status at ${url}`,
          });
        }
        if (pendingOrderStates.has(status)) {
          if (resp.retryAfterSeconds) ctx.retryAfterMs(resp.retryAfterSeconds * 1000);
          throw new Error(`Status still pending/processing: ${status}`);
        }
        if (terminalOrderStates.has(status) || status === "valid") {
          return resp.data as T;
        }
        throw new Error(`Unexpected status: ${status}`);
      },
      { attempts: this.backoffAttempts, minMs: this.backoffMin, maxMs: this.backoffMax }
    );
  }

  async finalizeOrder(order: Order, csrPem: Buffer | string): Promise<Order> {
    const csrDer = pemToDer(csrPem);
    const resp = await this.http.signedRequest<Order>(order.finalize, { csr: derToB64u(csrDer) }, { kid: this.getAccountUrl() });
    return { ...(resp.data as Order), url: order.url };
  }

  async getCertificate(order: Order): Promise<string> {
    let current: Order = order;
    if (!terminalOrderStates.has(current.status) && current.status !== "valid") {
      current = await this.waitForValidStatus<Order>(current.url);
    }
    if (!current.certificate) {
      throw new Error("Order complete but no certificate URL present");
    }
    const resp = await this.http.signedRequest<string>(current.certificate, null, { kid: this.getAccountUrl() });
    return typeof resp.data === "string" ? resp.data : String(resp.data);
  }

  async revokeCertificate(certPem: Buffer | string): Promise<void> {
    const der = pemToDer(certPem);
    const url = await this.http.getResourceUrl("revokeCert");
    await this.http.signedRequest<unknown>(url, { certificate: derToB64u(der) }, { kid: this.getAccountUrl() });
  }

  auto(opts: AutoOptions): Promise<string> {
    return auto(this, opts);
  }
}
