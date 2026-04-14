import { Request, Response, NextFunction, RequestHandler } from "express";
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
  return async (req: Request, res: Response, next: NextFunction) => {
    const apiToken = await cloudflareConfigService.getApiToken();
    if (!apiToken) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare API token not configured",
        details: "Please configure your Cloudflare API token first",
      });
    }
    const accountId = await cloudflareConfigService.getAccountId();
    if (!accountId) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare account ID not configured",
        details: "Please configure your Cloudflare account ID first",
      });
    }
    next();
  };
}
