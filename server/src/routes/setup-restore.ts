/**
 * Public, setup-scoped "Load from Backup" restore flow.
 *
 * Mounted at `/auth/setup/restore`. Every route runs BEFORE an admin account
 * exists, so none of the permission-gated `/api/storage/*` routes are usable
 * here. Instead we reuse the storage backends + config services directly,
 * persisting credentials under a sentinel user id (they live in the fresh DB
 * and are discarded the moment the restored DB swaps in).
 *
 * The whole router is gated by `requireSetupInProgress` — it 403s the instant a
 * user exists or setup is complete, so this surface closes as soon as the app
 * is set up (whether via fresh install or a completed restore).
 */

import express, {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { z } from "zod";
import { getLogger } from "../lib/logger-factory";
import prisma from "../lib/prisma";
import * as authSettingsService from "../lib/auth-settings-service";
import { StorageService } from "../services/storage/storage-service";
import { AzureStorageBackend } from "../services/storage/providers/azure/azure-storage-backend";
import { GoogleDriveBackend } from "../services/storage/providers/google-drive/google-drive-backend";
import { GoogleDriveTokenManager } from "../services/storage/providers/google-drive/google-drive-token-manager";
import {
  resolveGoogleDriveRedirectUri,
  GoogleDrivePublicUrlNotConfiguredError,
} from "../services/storage/providers/google-drive/google-drive-redirect";
import { buildOAuthState } from "../services/storage/providers/google-drive/google-drive-oauth-state";
import { requestOrigin } from "../lib/request-origin";
import {
  stageRestore,
  triggerRestoreRestart,
  BackupNewerThanImageError,
  RestoreArtifactInvalidError,
} from "../services/backup/self-restore-executor";
import { ProviderNoLongerConfiguredError } from "../services/storage/storage-service";
import { STORAGE_PROVIDER_IDS } from "@mini-infra/types";
import type {
  SetupRestoreBackupItem,
  SetupRestoreLocation,
} from "@mini-infra/types";

const logger = getLogger("backup", "setup-restore");
const router = express.Router();

/**
 * Audit user id for config rows written during the restore flow. There's no
 * real user yet; whatever we persist is thrown away when the restored DB
 * replaces this one.
 */
const SETUP_RESTORE_USER = "setup-restore";

/** Self-backup artifacts follow this naming: `mini-infra-<ts>.db.zip`. */
const BACKUP_NAME_PREFIX = "mini-infra-";
const BACKUP_NAME_SUFFIX = ".db.zip";

const providerSchema = z.enum(STORAGE_PROVIDER_IDS);

// ---------------------------------------------------------------------------
// Gate: only reachable while setup is genuinely in progress.
// ---------------------------------------------------------------------------

const requireSetupInProgress: RequestHandler = (async (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userCount = await prisma.user.count();
    const setupComplete = await authSettingsService.isSetupComplete();
    if (userCount > 0 || setupComplete) {
      return res
        .status(403)
        .json({ success: false, error: "Setup is not in progress" });
    }
    next();
  } catch (error) {
    next(error);
  }
}) as RequestHandler;

router.use(requireSetupInProgress);

// ---------------------------------------------------------------------------
// Status — lets the wizard resume after the Drive OAuth redirect round-trip.
// ---------------------------------------------------------------------------

router.get("/status", (async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const azureConfigured = await StorageService.getInstance(
      prisma,
    ).isProviderConfigured("azure");
    const tokens = new GoogleDriveTokenManager(prisma);
    const googleDriveConnected = (await tokens.getStoredTokens()) !== null;
    res.json({
      success: true,
      data: { setupInProgress: true, azureConfigured, googleDriveConnected },
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// ---------------------------------------------------------------------------
// Azure — set + validate connection string, list containers.
// ---------------------------------------------------------------------------

const azureCredentialsSchema = z.object({
  connectionString: z.string().min(1, "Connection string is required"),
});

router.post("/azure/credentials", (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const body = azureCredentialsSchema.safeParse(req.body);
    if (!body.success) {
      return res
        .status(400)
        .json({ success: false, error: "Bad Request", details: body.error.issues });
    }
    const backend = new AzureStorageBackend(prisma);
    // Validate the supplied connection string live BEFORE persisting, so we
    // never store an unusable credential.
    let validation;
    try {
      validation = await backend.validate({
        connectionString: body.data.connectionString,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : "Validation failed",
      });
    }
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        error: validation.message,
        errorCode: validation.errorCode,
      });
    }
    await backend.setConnectionString(body.data.connectionString, SETUP_RESTORE_USER);
    await StorageService.getInstance(prisma).setActiveProviderId(
      "azure",
      SETUP_RESTORE_USER,
    );
    res.json({
      success: true,
      data: { isValid: true, message: validation.message },
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.get("/azure/locations", (async (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const backend = new AzureStorageBackend(prisma);
    const locations = await backend.listLocations();
    res.json({ success: true, data: { locations: toLocations(locations) } });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// ---------------------------------------------------------------------------
// Google Drive — set client credentials, kick off OAuth, list folders.
// ---------------------------------------------------------------------------

const driveCredentialsSchema = z.object({
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client secret is required"),
});

router.post("/google-drive/credentials", (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const body = driveCredentialsSchema.safeParse(req.body);
    if (!body.success) {
      return res
        .status(400)
        .json({ success: false, error: "Bad Request", details: body.error.issues });
    }
    const tokens = new GoogleDriveTokenManager(prisma);
    await tokens.setOAuthCredentials(
      { clientId: body.data.clientId, clientSecret: body.data.clientSecret },
      SETUP_RESTORE_USER,
    );
    await StorageService.getInstance(prisma).setActiveProviderId(
      "google-drive",
      SETUP_RESTORE_USER,
    );
    res.json({ success: true, data: { clientIdConfigured: true } });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.get("/google-drive/oauth/start", (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const tokens = new GoogleDriveTokenManager(prisma);
    const credentials = await tokens.getOAuthCredentials();
    if (!credentials) {
      return res.status(400).json({
        success: false,
        error: "Google Drive client credentials are not configured",
        errorCode: "CLIENT_CREDENTIALS_MISSING",
      });
    }
    let redirectUri: string;
    try {
      redirectUri = await resolveGoogleDriveRedirectUri(requestOrigin(req));
    } catch (error) {
      if (error instanceof GoogleDrivePublicUrlNotConfiguredError) {
        return res
          .status(400)
          .json({ success: false, error: error.message, errorCode: error.code });
      }
      throw error;
    }
    const oauthClient = await tokens.buildOAuthClient(redirectUri);
    if (!oauthClient) {
      return res
        .status(500)
        .json({ success: false, error: "Failed to build Drive OAuth client" });
    }
    const authorizeUrl = oauthClient.generateAuthUrl(buildOAuthState());
    logger.info({ redirectUri }, "Issuing setup Google Drive authorize redirect");
    return res.redirect(302, authorizeUrl);
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.get("/google-drive/locations", (async (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const tokens = new GoogleDriveTokenManager(prisma);
    const snapshot = await tokens.getStoredTokens();
    if (!snapshot) {
      return res.json({ success: true, data: { locations: [] } });
    }
    const backend = StorageService.getInstance(prisma).getBackendByProviderId(
      "google-drive",
    ) as GoogleDriveBackend;
    const folders = await backend.listLocations();
    res.json({ success: true, data: { locations: toLocations(folders) } });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// ---------------------------------------------------------------------------
// Provider-agnostic: browse backups + execute the restore.
// ---------------------------------------------------------------------------

const backupsSchema = z.object({
  providerId: providerSchema,
  locationId: z.string().min(1, "Location is required"),
});

router.post("/backups", (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const body = backupsSchema.safeParse(req.body);
    if (!body.success) {
      return res
        .status(400)
        .json({ success: false, error: "Bad Request", details: body.error.issues });
    }
    const backend = await StorageService.getInstance(
      prisma,
    ).getBackendByProviderIdOrThrow(body.data.providerId);
    const result = await backend.list(
      { id: body.data.locationId },
      { prefix: BACKUP_NAME_PREFIX, limit: 200 },
    );
    const backups: SetupRestoreBackupItem[] = result.objects
      .filter(
        (o) =>
          o.name.startsWith(BACKUP_NAME_PREFIX) &&
          o.name.endsWith(BACKUP_NAME_SUFFIX),
      )
      .map((o) => ({
        objectName: o.name,
        sizeBytes: o.size,
        lastModified:
          o.lastModified?.toISOString() ?? o.createdAt?.toISOString() ?? null,
      }))
      .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
    res.json({ success: true, data: { backups } });
  } catch (error) {
    if (error instanceof ProviderNoLongerConfiguredError) {
      return res
        .status(409)
        .json({ success: false, error: error.message, errorCode: error.code });
    }
    next(error);
  }
}) as RequestHandler);

const executeSchema = z.object({
  providerId: providerSchema,
  locationId: z.string().min(1, "Location is required"),
  objectName: z.string().min(1, "Backup file is required"),
});

router.post("/execute", (async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const body = executeSchema.safeParse(req.body);
    if (!body.success) {
      return res
        .status(400)
        .json({ success: false, error: "Bad Request", details: body.error.issues });
    }
    // Make sure the active provider matches the one we're restoring from so
    // any downstream reads resolve the right backend.
    await StorageService.getInstance(prisma).setActiveProviderId(
      body.data.providerId,
      SETUP_RESTORE_USER,
    );

    let staged;
    try {
      staged = await stageRestore(
        {
          providerId: body.data.providerId,
          locationId: body.data.locationId,
          objectName: body.data.objectName,
        },
        prisma,
      );
    } catch (error) {
      if (error instanceof BackupNewerThanImageError) {
        return res.status(409).json({
          success: false,
          error: error.message,
          errorCode: error.code,
        });
      }
      if (error instanceof RestoreArtifactInvalidError) {
        return res.status(400).json({
          success: false,
          error: error.message,
          errorCode: error.code,
        });
      }
      if (error instanceof ProviderNoLongerConfiguredError) {
        return res.status(409).json({
          success: false,
          error: error.message,
          errorCode: error.code,
        });
      }
      throw error;
    }

    logger.warn(
      {
        providerId: body.data.providerId,
        objectName: body.data.objectName,
        sizeBytes: staged.sizeBytes,
      },
      "Restore staged from onboarding; restarting to apply",
    );

    // Respond first, THEN schedule the restart so the client learns the
    // restore is underway before the connection drops.
    res.status(202).json({
      success: true,
      data: { staged: true, sizeBytes: staged.sizeBytes },
    });
    triggerRestoreRestart();
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLocations(
  locations: { id: string; displayName: string }[],
): SetupRestoreLocation[] {
  return locations.map((l) => ({ id: l.id, displayName: l.displayName }));
}

export default router;
