import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { requireCloudflareCredentials } from "../require-credentials";
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

  it("returns 400 when the API token is missing", async () => {
    getApiToken.mockResolvedValue(null);

    const req = {} as Request;
    const res = buildResMock();
    const next = vi.fn() as NextFunction;

    await requireCloudflareCredentials(cloudflare)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Cloudflare API token not configured",
      }),
    );
    expect(next).not.toHaveBeenCalled();
    // Short-circuit — we should not check the account id once the token is absent.
    expect(getAccountId).not.toHaveBeenCalled();
  });

  it("returns 400 when the account id is missing", async () => {
    getApiToken.mockResolvedValue("token");
    getAccountId.mockResolvedValue(null);

    const req = {} as Request;
    const res = buildResMock();
    const next = vi.fn() as NextFunction;

    await requireCloudflareCredentials(cloudflare)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Cloudflare account ID not configured",
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next when both credentials are configured", async () => {
    getApiToken.mockResolvedValue("token");
    getAccountId.mockResolvedValue("account");

    const req = {} as Request;
    const res = buildResMock();
    const next = vi.fn() as NextFunction;

    await requireCloudflareCredentials(cloudflare)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
