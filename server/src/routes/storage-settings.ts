/**
 * Storage Settings API Routes (provider-agnostic).
 *
 * Replaces the previous `/api/settings/azure/*` surface. Mounted under
 * `/api/storage/*`.
 *
 * Endpoints:
 *   GET    /                       - Active provider id + per-slot location ids
 *   PUT    /active-provider        - Switch the active provider id
 *   GET    /switch-precheck        - Compute consequences/blockers before a switch (Phase 4)
 *   GET    /azure                  - Azure provider config (account name, configured-flag)
 *   PUT    /azure                  - Update Azure connection string (encrypted at rest)
 *   DELETE /azure                  - Wipe Azure provider config
 *   POST   /azure/validate         - Validate the (provided or stored) Azure connection string
 *   GET    /azure/locations        - List Azure containers via the active backend
 *   POST   /azure/test-location    - Test access to a specific Azure container
 *   POST   /:provider/forget       - Disconnect a provider entirely (Phase 4)
 *   GET    /locations/:slot        - Resolve which location id is wired to a slot
 *   PUT    /locations/:slot        - Wire a slot to a location id
 */

import express, {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";
import { getAuthenticatedUser, requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import {
  StorageNotConfiguredError,
  StorageProviderUnregisteredError,
  StorageService,
  STORAGE_LOCATION_KEYS,
} from "../services/storage/storage-service";
import { AzureStorageBackend } from "../services/storage/providers/azure/azure-storage-backend";
import { GoogleDriveBackend } from "../services/storage/providers/google-drive/google-drive-backend";
import {
  GoogleDriveTokenManager,
  DRIVE_SETTING_KEYS,
} from "../services/storage/providers/google-drive/google-drive-token-manager";
import {
  AzureContainerInfo,
  STORAGE_PROVIDER_IDS,
  StorageProviderId,
} from "@mini-infra/types";

const logger = getLogger("integrations", "storage-settings");
const router = express.Router();

const STORAGE_CATEGORY = "storage";

// ====================
// Schemas
// ====================

const updateActiveProviderSchema = z.object({
  providerId: z.enum(STORAGE_PROVIDER_IDS),
});

const updateAzureSettingSchema = z.object({
  connectionString: z
    .string()
    .min(1, "Connection string is required")
    .refine(
      (val) => {
        const requiredKeys = ["DefaultEndpointsProtocol", "AccountName", "AccountKey"];
        return requiredKeys.every((key) => val.includes(`${key}=`));
      },
      {
        message:
          "Invalid connection string format. Must include DefaultEndpointsProtocol, AccountName, and AccountKey",
      },
    )
    .optional(),
  accountName: z.string().optional(),
});

const validateAzureSchema = z.object({
  connectionString: z.string().optional(),
});

const testLocationSchema = z.object({
  locationId: z.string().min(1, "locationId is required"),
});

const slotKeySchema = z.enum([
  STORAGE_LOCATION_KEYS.POSTGRES_BACKUP,
  STORAGE_LOCATION_KEYS.SELF_BACKUP,
  STORAGE_LOCATION_KEYS.TLS_CERTIFICATES,
]);

const updateLocationSchema = z.object({
  locationId: z.string().min(1, "locationId is required"),
});

// ====================
// Helpers
// ====================

async function readSlotMap(): Promise<Record<string, string>> {
  const rows = await prisma.systemSettings.findMany({
    where: { category: STORAGE_CATEGORY, isActive: true },
  });
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.startsWith("locations.")) {
      map[row.key] = row.value;
    }
  }
  return map;
}

// ====================
// Routes
// ====================

/** GET / — return active provider + per-slot locations */
router.get("/", requirePermission("storage:read") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const storage = StorageService.getInstance(prisma);
    const activeProviderId = await storage.getActiveProviderId();
    const slotMap = await readSlotMap();
    res.json({
      success: true,
      data: {
        activeProviderId,
        locations: {
          postgresBackup: slotMap[STORAGE_LOCATION_KEYS.POSTGRES_BACKUP] ?? null,
          selfBackup: slotMap[STORAGE_LOCATION_KEYS.SELF_BACKUP] ?? null,
          tlsCertificates: slotMap[STORAGE_LOCATION_KEYS.TLS_CERTIFICATES] ?? null,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "Failed to load storage settings",
    );
    next(error);
  }
}) as RequestHandler);

/** PUT /active-provider — switch active storage provider */
router.put("/active-provider", requirePermission("storage:write") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
    }
    const body = updateActiveProviderSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        success: false,
        error: "Bad Request",
        details: body.error.issues,
      });
    }
    const storage = StorageService.getInstance(prisma);
    await storage.setActiveProviderId(body.data.providerId, user.id);
    res.json({
      success: true,
      data: { activeProviderId: body.data.providerId },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof StorageProviderUnregisteredError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    next(error);
  }
}) as RequestHandler);

// ----- Azure provider config -----

router.get("/azure", requirePermission("storage:read") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const backend = new AzureStorageBackend(prisma);
    const connectionString = await backend.getConnectionString();
    const accountName = await backend.getStorageAccountName();
    const health = await backend.getHealthStatus();
    res.json({
      success: true,
      data: {
        connectionConfigured: !!connectionString,
        accountName,
        validationStatus: health.status,
        validationMessage: health.errorMessage ?? null,
        lastValidatedAt: health.lastChecked?.toISOString() ?? null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.put("/azure", requirePermission("storage:write") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
    }
    const body = updateAzureSettingSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        success: false,
        error: "Bad Request",
        details: body.error.issues,
      });
    }
    const backend = new AzureStorageBackend(prisma);
    if (body.data.connectionString) {
      await backend.setConnectionString(body.data.connectionString, user.id);
    }
    if (body.data.accountName) {
      await backend.set("storage_account_name", body.data.accountName, user.id);
    }
    // Persist 'azure' as the active provider on a successful set.
    await StorageService.getInstance(prisma).setActiveProviderId(
      "azure",
      user.id,
    );
    const updatedAccountName = await backend.getStorageAccountName();
    const updatedConnectionString = await backend.getConnectionString();
    res.json({
      success: true,
      data: {
        connectionConfigured: !!updatedConnectionString,
        accountName: updatedAccountName,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.delete("/azure", requirePermission("storage:write") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
    }
    const backend = new AzureStorageBackend(prisma);
    await backend.removeConfiguration(user.id);
    res.json({
      success: true,
      message: "Azure storage configuration removed",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.post("/azure/validate", requirePermission("storage:write") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
    }
    const body = validateAzureSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json({
        success: false,
        error: "Bad Request",
        details: body.error.issues,
      });
    }
    const backend = new AzureStorageBackend(prisma);
    const result = await backend.validate(
      body.data.connectionString
        ? { connectionString: body.data.connectionString }
        : undefined,
    );
    res.json({
      success: true,
      data: {
        isValid: result.isValid,
        message: result.message,
        errorCode: result.errorCode,
        responseTimeMs: result.responseTimeMs,
        metadata: result.metadata,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.get("/azure/locations", requirePermission("storage:read") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const backend = new AzureStorageBackend(prisma);
    const locations = await backend.listLocations();
    // Shape-compatible response with the legacy /api/settings/azure/containers route
    // so the existing frontend can render the table without broader changes.
    const containers = locations.map(
      (l): AzureContainerInfo => ({
        name: l.id,
        lastModified: l.lastModified ?? new Date().toISOString(),
        leaseStatus: ((l.metadata as Record<string, string> | undefined)?.leaseStatus ??
          "unlocked") as AzureContainerInfo["leaseStatus"],
        leaseState: ((l.metadata as Record<string, string> | undefined)?.leaseState ??
          "available") as AzureContainerInfo["leaseState"],
        hasImmutabilityPolicy: Boolean(
          (l.metadata as Record<string, unknown> | undefined)?.hasImmutabilityPolicy,
        ),
        hasLegalHold: Boolean(
          (l.metadata as Record<string, unknown> | undefined)?.hasLegalHold,
        ),
        metadata:
          ((l.metadata as Record<string, unknown> | undefined)?.userMetadata as Record<string, string>) ?? undefined,
      }),
    );
    res.json({
      success: true,
      data: {
        accountName: (await backend.getStorageAccountName()) ?? "Unknown",
        containerCount: containers.length,
        containers,
        hasMore: false,
        nextMarker: undefined,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.post("/azure/test-location", requirePermission("storage:write") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const body = testLocationSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        success: false,
        error: "Bad Request",
        details: body.error.issues,
      });
    }
    const backend = new AzureStorageBackend(prisma);
    const info = await backend.testLocationAccess({ id: body.data.locationId });
    res.json({
      success: true,
      data: info,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// ----- Google Drive provider config -----

const updateDriveSettingSchema = z.object({
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
});

const createDriveFolderSchema = z.object({
  name: z.string().min(1, "Folder name is required").max(255),
});

function getDriveBackend(): GoogleDriveBackend {
  // The factory caches per-provider instances and wires the redirect resolver.
  return StorageService.getInstance(prisma).getBackendByProviderId(
    "google-drive",
  ) as GoogleDriveBackend;
}

router.get(
  "/google-drive",
  requirePermission("storage:read") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tokens = new GoogleDriveTokenManager(prisma);
      const credentials = await tokens.getOAuthCredentials();
      const snapshot = await tokens.getStoredTokens();
      const isConnected = !!snapshot;
      const backend = getDriveBackend();
      const health = await backend.getHealthStatus();
      res.json({
        success: true,
        data: {
          clientIdConfigured: !!credentials,
          clientId: credentials?.clientId ?? null,
          isConnected,
          accountEmail: snapshot?.accountEmail ?? null,
          tokenExpiresAt: snapshot?.expiryDate?.toISOString() ?? null,
          validationStatus: health.status,
          validationMessage: health.errorMessage ?? null,
          lastValidatedAt: health.lastChecked?.toISOString() ?? null,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

router.put(
  "/google-drive",
  requirePermission("storage:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res
          .status(401)
          .json({ success: false, error: "Unauthorized" });
      }
      const body = updateDriveSettingSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({
          success: false,
          error: "Bad Request",
          details: body.error.issues,
        });
      }
      const tokens = new GoogleDriveTokenManager(prisma);
      // Preserve existing pieces if only one of clientId/clientSecret is sent.
      const existing = await tokens.getOAuthCredentials();
      const clientId = body.data.clientId ?? existing?.clientId;
      const clientSecret = body.data.clientSecret ?? existing?.clientSecret;
      if (!clientId || !clientSecret) {
        return res.status(400).json({
          success: false,
          error: "Both clientId and clientSecret are required",
        });
      }
      // If client credentials change, drop the existing token rows — they
      // were minted with the old credentials and will refuse to refresh.
      if (
        existing &&
        (existing.clientId !== clientId ||
          existing.clientSecret !== clientSecret)
      ) {
        await tokens.clearTokens(user.id);
      }
      await tokens.setOAuthCredentials({ clientId, clientSecret }, user.id);
      // Persist 'google-drive' as the active provider on a successful set.
      await StorageService.getInstance(prisma).setActiveProviderId(
        "google-drive",
        user.id,
      );
      const refreshed = await tokens.getStoredTokens();
      res.json({
        success: true,
        data: {
          clientIdConfigured: true,
          clientId,
          isConnected: !!refreshed,
          accountEmail: refreshed?.accountEmail ?? null,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

router.delete(
  "/google-drive",
  requirePermission("storage:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res
          .status(401)
          .json({ success: false, error: "Unauthorized" });
      }
      const tokens = new GoogleDriveTokenManager(prisma);
      await tokens.clearAll(user.id);
      res.json({
        success: true,
        message: "Google Drive configuration removed",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

router.post(
  "/google-drive/disconnect",
  requirePermission("storage:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res
          .status(401)
          .json({ success: false, error: "Unauthorized" });
      }
      const tokens = new GoogleDriveTokenManager(prisma);
      await tokens.clearTokens(user.id);
      res.json({
        success: true,
        message: "Google Drive tokens cleared",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

router.post(
  "/google-drive/validate",
  requirePermission("storage:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const backend = getDriveBackend();
      const result = await backend.validate();
      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

router.get(
  "/google-drive/locations",
  requirePermission("storage:read") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const search =
        typeof req.query.search === "string" ? req.query.search : undefined;
      const limitRaw =
        typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit =
        limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(limitRaw, 200)
          : undefined;
      const backend = getDriveBackend();
      const tokens = new GoogleDriveTokenManager(prisma);
      const snapshot = await tokens.getStoredTokens();
      const folders = snapshot
        ? await backend.listLocations({ search, limit })
        : [];
      res.json({
        success: true,
        data: {
          accountEmail: snapshot?.accountEmail ?? null,
          folderCount: folders.length,
          folders: folders.map((f) => ({
            id: f.id,
            name: f.displayName,
            lastModified: f.lastModified ?? null,
            metadata: f.metadata ?? null,
          })),
          hasMore: false,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

router.post(
  "/google-drive/test-location",
  requirePermission("storage:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = testLocationSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({
          success: false,
          error: "Bad Request",
          details: body.error.issues,
        });
      }
      const backend = getDriveBackend();
      const info = await backend.testLocationAccess({ id: body.data.locationId });
      res.json({
        success: true,
        data: info,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

router.post(
  "/google-drive/create-folder",
  requirePermission("storage:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createDriveFolderSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({
          success: false,
          error: "Bad Request",
          details: body.error.issues,
        });
      }
      const backend = getDriveBackend();
      const info = await backend.createFolder(body.data.name);
      res.json({
        success: true,
        data: info,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

// Reference imports we want to keep loaded for the type system.
export { DRIVE_SETTING_KEYS };

// ----- Slot wiring -----

router.get("/locations/:slot", requirePermission("storage:read") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const slot = slotKeySchema.safeParse(req.params.slot);
    if (!slot.success) {
      return res.status(400).json({ success: false, error: "Unknown slot" });
    }
    const setting = await prisma.systemSettings.findUnique({
      where: {
        category_key: {
          category: STORAGE_CATEGORY,
          key: slot.data,
        },
      },
    });
    res.json({
      success: true,
      data: { slot: slot.data, locationId: setting?.value ?? null },
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.put("/locations/:slot", requirePermission("storage:write") as RequestHandler, (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    const slot = slotKeySchema.safeParse(req.params.slot);
    if (!slot.success) {
      return res.status(400).json({ success: false, error: "Unknown slot" });
    }
    const body = updateLocationSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        success: false,
        error: "Bad Request",
        details: body.error.issues,
      });
    }
    await prisma.systemSettings.upsert({
      where: {
        category_key: { category: STORAGE_CATEGORY, key: slot.data },
      },
      create: {
        category: STORAGE_CATEGORY,
        key: slot.data,
        value: body.data.locationId,
        isEncrypted: false,
        isActive: true,
        createdBy: user.id,
        updatedBy: user.id,
      },
      update: {
        value: body.data.locationId,
        updatedBy: user.id,
        updatedAt: new Date(),
      },
    });
    res.json({
      success: true,
      data: { slot: slot.data, locationId: body.data.locationId },
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// ====================
// Phase 4: switch precheck + provider forget
// ====================

const switchPrecheckQuerySchema = z.object({
  targetProvider: z.enum(STORAGE_PROVIDER_IDS),
});

const forgetProviderParamsSchema = z.object({
  provider: z.enum(STORAGE_PROVIDER_IDS),
});

const forgetQuerySchema = z.object({
  force: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional(),
});

const HARD_BLOCK_EVENT_TYPES = [
  "backup",
  "restore",
  "certificate_create",
  "certificate_renew",
] as const;

const IN_FLIGHT_STATUSES = ["pending", "running"] as const;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface SwitchPrecheckResponse {
  activeCerts: {
    count: number;
    soonestExpiryDays: number | null;
    anyWithin30Days: boolean;
  };
  acme: {
    hasInFlightChallenge: boolean;
  };
  selfBackupHistoryCount: number;
  postgresBackupHistoryCount: number;
  inFlightOperations: Array<{
    id: string;
    type: string;
    status: string;
    startedAt: string;
  }>;
  canSwitch: boolean;
  blockReasons: string[];
  warnings: string[];
}

/**
 * GET /switch-precheck — compute the consequence list and any hard-block
 * reasons for a proposed provider switch. Read-only; safe for any caller
 * with `storage:read`.
 *
 * Hard-block conditions:
 *  - Any UserEvent of type backup/restore/certificate_create/certificate_renew
 *    in pending/running status.
 *  - Any TLS certificate in PENDING or RENEWING status (in-flight ACME challenge).
 *
 * Hard-warn conditions:
 *  - Any TLS certificate within 30 days of expiry (rotate first).
 */
router.get(
  "/switch-precheck",
  requirePermission("storage:read") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = switchPrecheckQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: "Bad Request",
          details: parsed.error.issues,
        });
      }
      const targetProvider = parsed.data.targetProvider;
      const storage = StorageService.getInstance(prisma);
      const activeProviderId = await storage.getActiveProviderId();

      // No-op: target equals active. Surface canSwitch=true with empty lists.
      if (activeProviderId === targetProvider) {
        const data: SwitchPrecheckResponse = {
          activeCerts: { count: 0, soonestExpiryDays: null, anyWithin30Days: false },
          acme: { hasInFlightChallenge: false },
          selfBackupHistoryCount: 0,
          postgresBackupHistoryCount: 0,
          inFlightOperations: [],
          canSwitch: true,
          blockReasons: [],
          warnings: [],
        };
        return res.json({
          success: true,
          data,
          timestamp: new Date().toISOString(),
        });
      }

      // -- Active TLS certificates (count + soonest expiry) --
      const activeCerts = await prisma.tlsCertificate.findMany({
        where: { status: "ACTIVE" },
        select: { id: true, notAfter: true },
      });
      const now = Date.now();
      let soonestExpiryDays: number | null = null;
      let anyWithin30Days = false;
      for (const cert of activeCerts) {
        const ms = new Date(cert.notAfter).getTime() - now;
        const days = Math.floor(ms / (24 * 60 * 60 * 1000));
        if (soonestExpiryDays === null || days < soonestExpiryDays) {
          soonestExpiryDays = days;
        }
        if (ms < THIRTY_DAYS_MS) {
          anyWithin30Days = true;
        }
      }

      // -- ACME in-flight (PENDING/RENEWING) --
      const acmeInFlightCount = await prisma.tlsCertificate.count({
        where: { status: { in: ["PENDING", "RENEWING"] } },
      });
      const hasInFlightChallenge = acmeInFlightCount > 0;

      // -- History counts on the *outgoing* provider --
      // If there's no active provider yet, history counts are zero — first-pick
      // flow.
      let selfBackupHistoryCount = 0;
      let postgresBackupHistoryCount = 0;
      if (activeProviderId) {
        selfBackupHistoryCount = await prisma.selfBackup.count({
          where: { storageProviderAtCreation: activeProviderId },
        });
        postgresBackupHistoryCount = await prisma.backupOperation.count({
          where: { storageProviderAtCreation: activeProviderId },
        });
      }

      // -- In-flight long-running operations (backup/restore/cert) --
      const inFlightEvents = await prisma.userEvent.findMany({
        where: {
          eventType: { in: [...HARD_BLOCK_EVENT_TYPES] },
          status: { in: [...IN_FLIGHT_STATUSES] },
        },
        select: {
          id: true,
          eventType: true,
          status: true,
          startedAt: true,
        },
        orderBy: { startedAt: "desc" },
        take: 50,
      });

      const inFlightOperations = inFlightEvents.map((e) => ({
        id: e.id,
        type: e.eventType,
        status: e.status,
        startedAt: e.startedAt.toISOString(),
      }));

      const blockReasons: string[] = [];
      const warnings: string[] = [];

      if (inFlightOperations.length > 0) {
        blockReasons.push(
          `${inFlightOperations.length} long-running operation${inFlightOperations.length === 1 ? "" : "s"} in flight (backup/restore/certificate). Wait for ${inFlightOperations.length === 1 ? "it" : "them"} to finish or cancel before switching.`,
        );
      }

      if (hasInFlightChallenge) {
        blockReasons.push(
          `${acmeInFlightCount} TLS certificate${acmeInFlightCount === 1 ? " has an ACME challenge" : "s have ACME challenges"} in flight. Wait for issuance/renewal to finish before switching.`,
        );
      }

      if (anyWithin30Days) {
        warnings.push(
          `One or more active TLS certificates are within 30 days of expiry (soonest in ${soonestExpiryDays} day${soonestExpiryDays === 1 ? "" : "s"}). Switching providers regenerates the ACME account key — auto-renewal will not run on the old provider after the switch.`,
        );
      }

      if (activeCerts.length > 0) {
        warnings.push(
          `${activeCerts.length} active TLS certificate${activeCerts.length === 1 ? "" : "s"} stored under the current provider. They remain valid but will need to be re-issued under ${targetProvider} for auto-renewal to keep working.`,
        );
      }

      const canSwitch = blockReasons.length === 0;

      const data: SwitchPrecheckResponse = {
        activeCerts: {
          count: activeCerts.length,
          soonestExpiryDays,
          anyWithin30Days,
        },
        acme: { hasInFlightChallenge },
        selfBackupHistoryCount,
        postgresBackupHistoryCount,
        inFlightOperations,
        canSwitch,
        blockReasons,
        warnings,
      };

      res.json({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Failed to compute storage switch precheck",
      );
      next(error);
    }
  }) as RequestHandler,
);

/**
 * POST /:provider/forget — wipe a non-active provider's config rows.
 *
 * Refuses if the provider is currently active (returns 409). If any backup
 * history rows reference the provider via `storageProviderAtCreation`, refuses
 * unless `?force=true` is passed.
 *
 * Wipes both `(category="storage-{provider}")` rows AND clears any storage
 * slot wirings (`(category="storage", key="locations.*")`) that referenced the
 * provider's locations. The active provider selection itself is left alone.
 */
router.post(
  "/:provider/forget",
  requirePermission("storage:write") as RequestHandler,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return res
          .status(401)
          .json({ success: false, error: "Unauthorized" });
      }
      const params = forgetProviderParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({
          success: false,
          error: "Unknown provider",
          details: params.error.issues,
        });
      }
      const queryParsed = forgetQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        return res.status(400).json({
          success: false,
          error: "Bad Request",
          details: queryParsed.error.issues,
        });
      }
      const force =
        queryParsed.data.force === true || queryParsed.data.force === "true";
      const provider = params.data.provider;

      const storage = StorageService.getInstance(prisma);
      const activeProviderId = await storage.getActiveProviderId();
      if (activeProviderId === provider) {
        return res.status(409).json({
          success: false,
          error:
            "Cannot disconnect the currently active storage provider. Switch to a different provider first.",
        });
      }

      const [postgresRefCount, selfBackupRefCount] = await Promise.all([
        prisma.backupOperation.count({
          where: { storageProviderAtCreation: provider },
        }),
        prisma.selfBackup.count({
          where: { storageProviderAtCreation: provider },
        }),
      ]);
      const referencingRowCount = postgresRefCount + selfBackupRefCount;

      if (referencingRowCount > 0 && !force) {
        return res.status(409).json({
          success: false,
          error: "PROVIDER_HAS_REFERENCING_ROWS",
          message: `Cannot disconnect ${provider}: ${referencingRowCount} backup history row${referencingRowCount === 1 ? "" : "s"} reference${referencingRowCount === 1 ? "s" : ""} this provider. Pass ?force=true to disconnect anyway (those rows will become unrestorable).`,
          data: {
            provider,
            referencingRowCount,
            postgresBackupHistoryCount: postgresRefCount,
            selfBackupHistoryCount: selfBackupRefCount,
          },
        });
      }

      // Wipe per-provider config rows (category="storage-{provider}"). Slot
      // wirings (category="storage", key="locations.*") are owned by the
      // active provider and stay intact.
      const providerCategory = `storage-${provider}`;
      const deleted = await prisma.systemSettings.deleteMany({
        where: { category: providerCategory },
      });

      logger.info(
        {
          provider,
          force,
          referencingRowCount,
          deletedConfigRowCount: deleted.count,
          userId: user.id,
        },
        "Forgot storage provider configuration",
      );

      res.json({
        success: true,
        message: `Disconnected ${provider}`,
        data: {
          provider,
          referencingRowCount,
          deletedConfigRowCount: deleted.count,
          forced: force,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

export default router;

// Re-export the not-configured error type so call sites can mention it
// without dipping into the storage service module directly.
export { StorageNotConfiguredError };
// Reference imports we want to keep loaded for the type system.
export type { StorageProviderId };
