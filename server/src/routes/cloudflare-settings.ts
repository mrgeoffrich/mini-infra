import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
import { requirePermission, getAuthenticatedUser } from "../middleware/auth";
import prisma from "../lib/prisma";
import { CloudflareService } from "../services/cloudflare";
import {
  CreateCloudflareSettingRequest,
  UpdateCloudflareSettingRequest,
  CloudflareSettingResponse,
  CloudflareValidationResponse,
  CloudflareTunnelListResponse,
  CloudflareTunnelDetailsResponse,
  CloudflareTunnelConfigResponse,
  CloudflareTunnelInfo,
  CloudflareAddHostnameRequest,
  CloudflareHostnameResponse,
} from "@mini-infra/types";

const router = express.Router();

// Create Cloudflare configuration service instance
const cloudflareConfigService = new CloudflareService(prisma);

// Cache for tunnel data with 60-second TTL
interface TunnelCacheEntry {
  data: any;
  timestamp: number;
}
const tunnelCache: Map<string, TunnelCacheEntry> = new Map();
const TUNNEL_CACHE_TTL = 60000; // 60 seconds

// Request validation schemas
const createCloudflareSettingSchema = z.object({
  api_token: z.string().min(40, "API token must be at least 40 characters"),
  account_id: z.string().min(1, "Account ID is required").regex(/^[a-f0-9]{32}$/, "Account ID must be a valid 32-character hex string"),
  encrypt: z.boolean().optional().default(true),
});

const updateCloudflareSettingSchema = z.object({
  api_token: z
    .string()
    .min(40, "API token must be at least 40 characters")
    .optional(),
  account_id: z.string().min(1, "Account ID is required").regex(/^[a-f0-9]{32}$/, "Account ID must be a valid 32-character hex string").optional(),
  encrypt: z.boolean().optional().default(true),
});

const validateCloudflareConnectionSchema = z.object({
  api_token: z.string().optional(),
});

/**
 * GET /api/settings/cloudflare - Get current Cloudflare configuration
 */
router.get("/", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "Cloudflare settings requested",
  );

  try {
    const apiToken = await cloudflareConfigService.get("api_token");
    const accountId = await cloudflareConfigService.get("account_id");

    const response: CloudflareSettingResponse = {
      success: true,
      data: {
        isConfigured: !!apiToken,
        hasApiToken: !!apiToken,
        accountId: accountId || undefined,
      },
    };

    logger.debug(
      {
        requestId,
        userId,
        isConfigured: response.data.isConfigured,
      },
      "Cloudflare settings retrieved successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to retrieve Cloudflare settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/cloudflare - Create or update Cloudflare configuration
 */
router.post("/", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
      hasApiToken: !!req.body.api_token,
      hasAccountId: !!req.body.account_id,
    },
    "Cloudflare settings update requested",
  );

  try {
    // Validate request body
    const validationResult = createCloudflareSettingSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid Cloudflare settings request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { api_token, account_id } = validationResult.data;

    // Check if configuration already exists
    const existingApiToken = await cloudflareConfigService.get("api_token");
    const existingAccountId = await cloudflareConfigService.get("account_id");

    if (existingApiToken) {
      // Update existing configuration
      await cloudflareConfigService.setApiToken(api_token, userId);
      await cloudflareConfigService.setAccountId(account_id, userId);

      logger.debug(
        {
          requestId,
          userId,
        },
        "Cloudflare settings updated successfully",
      );
    } else {
      // Create new configuration
      await cloudflareConfigService.setApiToken(api_token, userId);
      await cloudflareConfigService.setAccountId(account_id, userId);

      logger.debug(
        {
          requestId,
          userId,
        },
        "Cloudflare settings created successfully",
      );
    }

    // Validate the configuration
    const validationResponse = await cloudflareConfigService.validate();

    const response: CloudflareSettingResponse = {
      success: true,
      data: {
        isConfigured: true,
        hasApiToken: true,
        accountId: account_id,
        isValid: validationResponse.isValid,
        validationMessage: validationResponse.message,
      },
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to update Cloudflare settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * PATCH /api/settings/cloudflare - Partially update Cloudflare configuration
 */
router.patch("/", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
      hasApiToken: !!req.body.api_token,
      hasAccountId: !!req.body.account_id,
    },
    "Cloudflare settings partial update requested",
  );

  try {
    // Validate request body
    const validationResult = updateCloudflareSettingSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid Cloudflare settings update request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { api_token, account_id } = validationResult.data;

    // Update only provided fields
    if (api_token) {
      await cloudflareConfigService.setApiToken(api_token, userId);
    }
    if (account_id !== undefined) {
      if (account_id) {
        await cloudflareConfigService.setAccountId(account_id, userId);
      } else {
        // Allow clearing account_id
        await cloudflareConfigService.delete("account_id", userId);
      }
    }

    // Validate the configuration
    const validationResponse = await cloudflareConfigService.validate();

    const currentAccountId = await cloudflareConfigService.get("account_id");

    const response: CloudflareSettingResponse = {
      success: true,
      data: {
        isConfigured: true,
        hasApiToken: true,
        accountId: currentAccountId || undefined,
        isValid: validationResponse.isValid,
        validationMessage: validationResponse.message,
      },
    };

    logger.debug(
      {
        requestId,
        userId,
        isValid: validationResponse.isValid,
      },
      "Cloudflare settings updated successfully",
    );

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to update Cloudflare settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * DELETE /api/settings/cloudflare - Remove Cloudflare configuration
 */
router.delete("/", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "Cloudflare settings deletion requested",
  );

  try {
    // Delete all Cloudflare settings
    await cloudflareConfigService.delete("api_token", userId);
    await cloudflareConfigService.delete("account_id", userId);

    logger.debug(
      {
        requestId,
        userId,
      },
      "Cloudflare settings deleted successfully",
    );

    const response: CloudflareSettingResponse = {
      success: true,
      data: {
        isConfigured: false,
        hasApiToken: false,
      },
    };

    res.json(response);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to delete Cloudflare settings",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/cloudflare/test - Test Cloudflare API connectivity
 */
router.post("/test", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "Cloudflare connection test requested",
  );

  try {
    // Validate request body
    const validationResult = validateCloudflareConnectionSchema.safeParse(
      req.body,
    );
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          errors: validationResult.error.flatten(),
        },
        "Invalid Cloudflare validation request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { api_token } = validationResult.data;

    // If api_token is provided, temporarily set it for validation
    let originalApiToken: string | null = null;
    if (api_token) {
      originalApiToken = await cloudflareConfigService.get("api_token");
      await cloudflareConfigService.setApiToken(api_token, userId);
    }

    try {
      // Validate the configuration
      const validationResponse = await cloudflareConfigService.validate();

      const response: CloudflareValidationResponse = {
        success: validationResponse.isValid,
        data: {
          isValid: validationResponse.isValid,
          message: validationResponse.message,
          errorCode: validationResponse.errorCode,
          metadata: validationResponse.metadata,
          responseTimeMs: validationResponse.responseTimeMs || 0,
        },
      };

      logger.debug(
        {
          requestId,
          userId,
          isValid: validationResponse.isValid,
          responseTimeMs: validationResponse.responseTimeMs,
        },
        "Cloudflare connection test completed",
      );

      res.json(response);
    } finally {
      // Restore original api_token if temporarily changed
      if (api_token && originalApiToken !== null) {
        await cloudflareConfigService.setApiToken(originalApiToken, userId);
      }
    }
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Failed to test Cloudflare connection",
    );

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/cloudflare/tunnels - List all Cloudflare tunnels
 */
router.get("/tunnels", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";

  logger.debug(
    {
      requestId,
      userId,
    },
    "Cloudflare tunnels list requested",
  );

  try {
    // Check cache first
    const cacheKey = "tunnels_list";
    const cached = tunnelCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < TUNNEL_CACHE_TTL) {
      logger.debug(
        {
          requestId,
          userId,
          tunnelCount: cached.data.length,
        },
        "Returning cached tunnel list",
      );

      const response: CloudflareTunnelListResponse = {
        success: true,
        data: {
          tunnels: cached.data,
          tunnelCount: cached.data.length,
        },
      };

      return res.json(response);
    }

    // Check if API token and account ID are configured
    const apiToken = await cloudflareConfigService.getApiToken();
    const accountId = await cloudflareConfigService.getAccountId();

    logger.debug(
      {
        requestId,
        userId,
        hasApiToken: !!apiToken,
        hasAccountId: !!accountId,
        accountId: accountId ? `${accountId.substring(0, 8)}...` : "not set",
      },
      "Cloudflare configuration check for tunnels",
    );

    if (!apiToken) {
      logger.warn(
        { requestId, userId },
        "API token not configured for tunnel retrieval",
      );
      return res.status(400).json({
        success: false,
        error: "Cloudflare API token not configured",
        details: "Please configure your Cloudflare API token first",
      });
    }

    if (!accountId) {
      logger.warn(
        { requestId, userId },
        "Account ID not configured for tunnel retrieval",
      );
      return res.status(400).json({
        success: false,
        error: "Cloudflare account ID not configured",
        details: "Please configure your Cloudflare account ID first",
      });
    }

    // Fetch tunnel information from Cloudflare API
    const tunnels = await cloudflareConfigService.getTunnelInfo();

    logger.debug(
      {
        requestId,
        userId,
        tunnelCount: tunnels.length,
        tunnelNames: tunnels.map((t) => t.name),
      },
      "Raw tunnel data from Cloudflare API",
    );

    // Transform tunnel data for frontend consumption and filter out deleted tunnels
    const transformedTunnels = tunnels
      .filter((tunnel: any) => !tunnel.deleted_at) // Filter out deleted tunnels
      .map((tunnel: any) => ({
        id: tunnel.id,
        name: tunnel.name,
        status: tunnel.status as "healthy" | "degraded" | "down" | "inactive",
        createdAt: tunnel.created_at,
        deletedAt: tunnel.deleted_at,
        connections: tunnel.connections || [],
      }));

    // Update cache
    tunnelCache.set(cacheKey, {
      data: transformedTunnels,
      timestamp: Date.now(),
    });

    logger.debug(
      {
        requestId,
        userId,
        tunnelCount: transformedTunnels.length,
      },
      "Cloudflare tunnels retrieved successfully",
    );

    const response: CloudflareTunnelListResponse = {
      success: true,
      data: {
        tunnels: transformedTunnels,
        tunnelCount: transformedTunnels.length,
      },
    };

    res.json(response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.error(
      {
        requestId,
        userId,
        error: errorMessage,
      },
      "Failed to retrieve Cloudflare tunnels",
    );

    // Return appropriate error response based on error type
    if (errorMessage.includes("API token not configured")) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare API token not configured",
        details: "Please configure your Cloudflare API token first",
      });
    }

    if (errorMessage.includes("Account ID not configured")) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare account ID not configured",
        details: "Please configure your Cloudflare account ID first",
      });
    }

    if (errorMessage.includes("timeout")) {
      return res.status(504).json({
        success: false,
        error: "Request timeout",
        details: "The request to Cloudflare API timed out",
      });
    }

    if (errorMessage.includes("Rate limit")) {
      return res.status(429).json({
        success: false,
        error: "Rate limited",
        details: "Too many requests to Cloudflare API. Please try again later.",
      });
    }

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/cloudflare/tunnels/:id - Get specific tunnel details
 */
router.get("/tunnels/:id", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";
  const { id: tunnelId } = req.params;

  logger.debug(
    {
      requestId,
      userId,
      tunnelId,
    },
    "Cloudflare tunnel details requested",
  );

  try {
    // Check cache first for tunnel list
    const cacheKey = `tunnel_${tunnelId}`;
    const cached = tunnelCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < TUNNEL_CACHE_TTL) {
      logger.debug(
        {
          requestId,
          userId,
          tunnelId,
        },
        "Returning cached tunnel details",
      );

      const response: CloudflareTunnelDetailsResponse = {
        success: true,
        data: cached.data,
      };

      return res.json(response);
    }

    // Get API credentials
    const apiToken = await cloudflareConfigService.getApiToken();
    const accountId = await cloudflareConfigService.getAccountId();

    if (!apiToken) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare API token not configured",
        details: "Please configure your Cloudflare API token first",
      });
    }

    if (!accountId) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare account ID not configured",
        details: "Please configure your Cloudflare account ID first",
      });
    }

    // Import Cloudflare SDK
    const Cloudflare = (await import("cloudflare")).default;
    const cf = new Cloudflare({ apiToken });

    // Fetch tunnels list and find the specific tunnel
    const tunnelsResponse = (await Promise.race([
      cf.zeroTrust.tunnels.list({ account_id: accountId }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Tunnel API request timeout")),
          10000, // 10 second timeout
        ),
      ),
    ])) as any;

    // Find the specific tunnel from the list
    const tunnelResponse = tunnelsResponse.result?.find(
      (t: any) => t.id === tunnelId,
    );

    if (!tunnelResponse) {
      return res.status(404).json({
        success: false,
        error: "Tunnel not found",
        details: `Tunnel with ID ${tunnelId} was not found`,
      });
    }

    // Transform tunnel data to match CloudflareTunnelInfo type
    const transformedTunnel: CloudflareTunnelInfo = {
      id: tunnelResponse.id,
      name: tunnelResponse.name,
      status: tunnelResponse.status as
        | "healthy"
        | "degraded"
        | "down"
        | "inactive",
      createdAt: tunnelResponse.created_at,
      deletedAt: tunnelResponse.deleted_at,
      connections: tunnelResponse.connections || [],
      connectorId: tunnelResponse.connector_id,
      activeTunnelConnections: tunnelResponse.connections?.length || 0,
      metadata: {
        config_src: tunnelResponse.config_src,
        remote_config: tunnelResponse.remote_config,
      },
    };

    // Update cache
    tunnelCache.set(cacheKey, {
      data: transformedTunnel,
      timestamp: Date.now(),
    });

    logger.debug(
      {
        requestId,
        userId,
        tunnelId,
        tunnelName: transformedTunnel.name,
      },
      "Cloudflare tunnel details retrieved successfully",
    );

    const response: CloudflareTunnelDetailsResponse = {
      success: true,
      data: transformedTunnel,
    };

    res.json(response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.error(
      {
        requestId,
        userId,
        tunnelId,
        error: errorMessage,
      },
      "Failed to retrieve Cloudflare tunnel details",
    );

    // Return appropriate error response based on error type
    if (errorMessage.includes("timeout")) {
      return res.status(504).json({
        success: false,
        error: "Request timeout",
        details: "The request to Cloudflare API timed out",
      });
    }

    if (errorMessage.includes("404") || errorMessage.includes("not found")) {
      return res.status(404).json({
        success: false,
        error: "Tunnel not found",
        details: `Tunnel with ID ${tunnelId} was not found`,
      });
    }

    if (errorMessage.includes("Rate limit")) {
      return res.status(429).json({
        success: false,
        error: "Rate limited",
        details: "Too many requests to Cloudflare API. Please try again later.",
      });
    }

    next(error);
  }
}) as RequestHandler);

/**
 * GET /api/cloudflare/tunnels/:id/config - Get specific tunnel configuration
 */
router.get("/tunnels/:id/config", requirePermission('settings:read') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";
  const { id: tunnelId } = req.params;

  logger.debug(
    {
      requestId,
      userId,
      tunnelId,
    },
    "Cloudflare tunnel configuration requested",
  );

  try {
    // Check cache first for tunnel config
    const cacheKey = `tunnel_config_${tunnelId}`;
    const cached = tunnelCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < TUNNEL_CACHE_TTL) {
      logger.debug(
        {
          requestId,
          userId,
          tunnelId,
        },
        "Returning cached tunnel configuration",
      );

      const response: CloudflareTunnelConfigResponse = {
        success: true,
        data: cached.data,
      };

      return res.json(response);
    }

    // Get API credentials
    const apiToken = await cloudflareConfigService.getApiToken();
    const accountId = await cloudflareConfigService.getAccountId();

    if (!apiToken) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare API token not configured",
        details: "Please configure your Cloudflare API token first",
      });
    }

    if (!accountId) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare account ID not configured",
        details: "Please configure your Cloudflare account ID first",
      });
    }

    // Fetch tunnel configuration
    const tunnelConfig =
      await cloudflareConfigService.getTunnelConfig(tunnelId);

    if (!tunnelConfig) {
      return res.status(404).json({
        success: false,
        error: "Tunnel configuration not found",
        details: `Configuration for tunnel ${tunnelId} was not found or could not be retrieved`,
      });
    }

    // Update cache
    tunnelCache.set(cacheKey, {
      data: tunnelConfig,
      timestamp: Date.now(),
    });

    logger.debug(
      {
        requestId,
        userId,
        tunnelId,
        configVersion: tunnelConfig.version,
        ingressRuleCount: tunnelConfig.config?.ingress?.length || 0,
      },
      "Cloudflare tunnel configuration retrieved successfully",
    );

    const response: CloudflareTunnelConfigResponse = {
      success: true,
      data: tunnelConfig,
    };

    res.json(response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.error(
      {
        requestId,
        userId,
        tunnelId,
        error: errorMessage,
      },
      "Failed to retrieve Cloudflare tunnel configuration",
    );

    // Return appropriate error response based on error type
    if (errorMessage.includes("timeout")) {
      return res.status(504).json({
        success: false,
        error: "Request timeout",
        details: "The request to Cloudflare API timed out",
      });
    }

    if (errorMessage.includes("404") || errorMessage.includes("not found")) {
      return res.status(404).json({
        success: false,
        error: "Tunnel configuration not found",
        details: `Configuration for tunnel ${tunnelId} was not found`,
      });
    }

    if (errorMessage.includes("Rate limit")) {
      return res.status(429).json({
        success: false,
        error: "Rate limited",
        details: "Too many requests to Cloudflare API. Please try again later.",
      });
    }

    next(error);
  }
}) as RequestHandler);

/**
 * POST /api/settings/cloudflare/tunnels/:id/hostnames - Add hostname to tunnel
 */
router.post("/tunnels/:id/hostnames", requirePermission('settings:write') as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = req.headers["x-request-id"] as string;
  const user = getAuthenticatedUser(req);
  const userId = user?.id || "system";
  const { id: tunnelId } = req.params;

  logger.debug(
    {
      requestId,
      userId,
      tunnelId,
      hostname: req.body.hostname,
      service: req.body.service,
    },
    "Add hostname to tunnel requested",
  );

  try {
    // Validate request body
    const addHostnameSchema = z.object({
      hostname: z
        .string()
        .min(1, "Hostname is required")
        .refine(
          (hostname) => {
            // Basic hostname validation
            const hostnameRegex =
              /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
            return hostnameRegex.test(hostname) || hostname.startsWith("*.");
          },
          { message: "Invalid hostname format" },
        ),
      service: z
        .string()
        .min(1, "Service is required")
        .refine(
          (service) => {
            // Basic service URL validation
            try {
              new URL(service);
              return true;
            } catch {
              // Also allow simple formats like "localhost:3000"
              return (/^[a-zA-Z0-9.-]+:\d+$/.test(service) || /^https?:\/\//.test(service));
            }
          },
          { message: "Invalid service URL format" },
        ),
      path: z.string().optional(),
    });

    const validationResult = addHostnameSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn(
        {
          requestId,
          userId,
          tunnelId,
          errors: validationResult.error.flatten(),
        },
        "Invalid add hostname request",
      );

      return res.status(400).json({
        success: false,
        error: "Invalid request parameters",
        details: validationResult.error.flatten(),
      });
    }

    const { hostname, service, path } = validationResult.data;

    // Check if API token and account ID are configured
    const apiToken = await cloudflareConfigService.getApiToken();
    const accountId = await cloudflareConfigService.getAccountId();

    if (!apiToken) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare API token not configured",
        details: "Please configure your Cloudflare API token first",
      });
    }

    if (!accountId) {
      return res.status(400).json({
        success: false,
        error: "Cloudflare account ID not configured",
        details: "Please configure your Cloudflare account ID first",
      });
    }

    // Add hostname to tunnel configuration
    const updatedConfig = await cloudflareConfigService.addHostname(
      tunnelId,
      hostname,
      service,
      path,
    );

    if (!updatedConfig) {
      return res.status(500).json({
        success: false,
        error: "Failed to update tunnel configuration",
        details: "Unable to add hostname to tunnel",
      });
    }

    logger.debug(
      {
        requestId,
        userId,
        tunnelId,
        hostname,
        service,
        path,
        configVersion: updatedConfig.version,
      },
      "Hostname added to tunnel successfully",
    );

    res.json({
      success: true,
      data: {
        tunnelId,
        hostname,
        service,
        path,
        configVersion: updatedConfig.version,
      },
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.error(
      {
        requestId,
        userId,
        tunnelId,
        hostname: req.body.hostname,
        error: errorMessage,
      },
      "Failed to add hostname to tunnel",
    );

    // Return appropriate error response based on error type
    if (errorMessage.includes("already exists")) {
      return res.status(409).json({
        success: false,
        error: "Hostname already exists",
        details: errorMessage,
      });
    }

    if (errorMessage.includes("timeout")) {
      return res.status(504).json({
        success: false,
        error: "Request timeout",
        details: "The request to Cloudflare API timed out",
      });
    }

    if (errorMessage.includes("Rate limit")) {
      return res.status(429).json({
        success: false,
        error: "Rate limited",
        details: "Too many requests to Cloudflare API. Please try again later.",
      });
    }

    next(error);
  }
}) as RequestHandler);

/**
 * DELETE /api/settings/cloudflare/tunnels/:id/hostnames/:hostname - Remove hostname from tunnel
 */
router.delete(
  "/tunnels/:id/hostnames/:hostname",
  requirePermission('settings:write') as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    const requestId = req.headers["x-request-id"] as string;
    const user = getAuthenticatedUser(req);
    const userId = user?.id || "system";
    const { id: tunnelId, hostname } = req.params;
    const { path } = req.query;

    logger.debug(
      {
        requestId,
        userId,
        tunnelId,
        hostname,
        path,
      },
      "Remove hostname from tunnel requested",
    );

    try {
      // URL decode hostname in case it contains special characters
      const decodedHostname = decodeURIComponent(hostname);

      // Check if API token and account ID are configured
      const apiToken = await cloudflareConfigService.getApiToken();
      const accountId = await cloudflareConfigService.getAccountId();

      if (!apiToken) {
        return res.status(400).json({
          success: false,
          error: "Cloudflare API token not configured",
          details: "Please configure your Cloudflare API token first",
        });
      }

      if (!accountId) {
        return res.status(400).json({
          success: false,
          error: "Cloudflare account ID not configured",
          details: "Please configure your Cloudflare account ID first",
        });
      }

      // Remove hostname from tunnel configuration
      const updatedConfig = await cloudflareConfigService.removeHostname(
        tunnelId,
        decodedHostname,
        path as string | undefined,
      );

      if (!updatedConfig) {
        return res.status(500).json({
          success: false,
          error: "Failed to update tunnel configuration",
          details: "Unable to remove hostname from tunnel",
        });
      }

      logger.debug(
        {
          requestId,
          userId,
          tunnelId,
          hostname: decodedHostname,
          path,
          configVersion: updatedConfig.version,
        },
        "Hostname removed from tunnel successfully",
      );

      res.json({
        success: true,
        data: {
          tunnelId,
          hostname: decodedHostname,
          path,
          configVersion: updatedConfig.version,
        },
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        {
          requestId,
          userId,
          tunnelId,
          hostname,
          error: errorMessage,
        },
        "Failed to remove hostname from tunnel",
      );

      // Return appropriate error response based on error type
      if (errorMessage.includes("not found")) {
        return res.status(404).json({
          success: false,
          error: "Hostname not found",
          details: errorMessage,
        });
      }

      if (errorMessage.includes("timeout")) {
        return res.status(504).json({
          success: false,
          error: "Request timeout",
          details: "The request to Cloudflare API timed out",
        });
      }

      if (errorMessage.includes("Rate limit")) {
        return res.status(429).json({
          success: false,
          error: "Rate limited",
          details:
            "Too many requests to Cloudflare API. Please try again later.",
        });
      }

      next(error);
    }
  }) as RequestHandler,
);

export default router;
