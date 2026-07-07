import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { requireCloudflareCredentials } from "../require-credentials";
import { ValidationError } from "../../../lib/errors";
import type { CloudflareService } from "../../../services/cloudflare";

function buildResMock() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  (res.json as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("requireCloudflareCredentials", () => {
  let cloudflare: CloudflareService;
  let getApiToken: ReturnType<typeof vi.fn>;
  let getAccountId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getApiToken = vi.fn();
    getAccountId = vi.fn();
    cloudflare = {
      getApiToken,
      getAccountId,
    } as unknown as CloudflareService;
  });

  it("forwards a CLOUDFLARE_API_TOKEN_NOT_CONFIGURED ValidationError to next() when the API token is missing", async () => {
    getApiToken.mockResolvedValue(null);

    const req = {} as Request;
    const res = buildResMock();
    const next = vi.fn() as NextFunction;

    // asyncHandler (server/src/lib/async-handler.ts) wraps the handler in a
    // synchronous function that fires the async work and attaches
    // `.catch(next)` without returning the promise — so the call below
    // doesn't itself resolve until the wrapper returns, not until the
    // wrapped async work finishes. Wait for `next` to observe that.
    requireCloudflareCredentials(cloudflare)(req, res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next).toHaveBeenCalledTimes(1);
    const forwardedError = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(forwardedError).toBeInstanceOf(ValidationError);
    expect(forwardedError).toMatchObject({
      statusCode: 400,
      code: "CLOUDFLARE_API_TOKEN_NOT_CONFIGURED",
      resource: { type: "cloudflareConfig" },
    });
    // Short-circuit — we should not check the account id once the token is absent.
    expect(getAccountId).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("forwards a CLOUDFLARE_ACCOUNT_ID_NOT_CONFIGURED ValidationError to next() when the account id is missing", async () => {
    getApiToken.mockResolvedValue("token");
    getAccountId.mockResolvedValue(null);

    const req = {} as Request;
    const res = buildResMock();
    const next = vi.fn() as NextFunction;

    requireCloudflareCredentials(cloudflare)(req, res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next).toHaveBeenCalledTimes(1);
    const forwardedError = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(forwardedError).toBeInstanceOf(ValidationError);
    expect(forwardedError).toMatchObject({
      statusCode: 400,
      code: "CLOUDFLARE_ACCOUNT_ID_NOT_CONFIGURED",
      resource: { type: "cloudflareConfig" },
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next with no error when both credentials are configured", async () => {
    getApiToken.mockResolvedValue("token");
    getAccountId.mockResolvedValue("account");

    const req = {} as Request;
    const res = buildResMock();
    const next = vi.fn() as NextFunction;

    requireCloudflareCredentials(cloudflare)(req, res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
