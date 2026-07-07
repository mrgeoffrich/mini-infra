import { Request, Response, NextFunction, RequestHandler } from "express";
import { ErrorCode } from "@mini-infra/types";
import { ValidationError } from "../../lib/errors";
import { asyncHandler } from "../../lib/async-handler";
import { CloudflareService } from "../../services/cloudflare";

/**
 * Middleware that rejects requests with 400 when either the Cloudflare
 * API token or account ID is missing. Extracted so every tunnel / managed
 * tunnel route doesn't have to re-implement the same guard.
 *
 * The service instance is injected rather than constructed here because
 * we want the same {@link CloudflareService} (and therefore the same
 * circuit breaker + runner) to back every call in a request.
 */
export function requireCloudflareCredentials(
  cloudflareConfigService: CloudflareService,
): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const apiToken = await cloudflareConfigService.getApiToken();
    if (!apiToken) {
      throw new ValidationError(
        ErrorCode.CLOUDFLARE_API_TOKEN_NOT_CONFIGURED,
        "Cloudflare API token not configured",
        {
          resource: { type: "cloudflareConfig" },
          action: "Configure your Cloudflare API token in Settings > Cloudflare.",
        },
      );
    }
    const accountId = await cloudflareConfigService.getAccountId();
    if (!accountId) {
      throw new ValidationError(
        ErrorCode.CLOUDFLARE_ACCOUNT_ID_NOT_CONFIGURED,
        "Cloudflare account ID not configured",
        {
          resource: { type: "cloudflareConfig" },
          action: "Configure your Cloudflare account ID in Settings > Cloudflare.",
        },
      );
    }
    next();
  });
}
