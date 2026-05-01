/**
 * Persistent OAuth token store for the Google Drive storage provider.
 *
 * Modelled on `server/src/services/github-app/github-app-oauth.ts` —
 * `getValidAccessToken()` auto-refreshes 5 minutes before expiry and keeps
 * the persisted token + refresh token in `(category="storage-google-drive",
 * key="...")`. Secrets (`access_token`, `refresh_token`) go through
 * `setSecure`/`getSecure`; `token_expiry`, `account_email`, and the BYO
 * `client_id` are plaintext.
 *
 * On decrypt failure (e.g. crypto secret rotated, ciphertext tampered), the
 * manager surfaces an `unauthorized` connectivity status under
 * `service="storage"` and returns null — never throws to the caller. The
 * frontend reads that status and shows the "Reconnect" CTA.
 */

import type { PrismaClient } from "../../../../lib/prisma";
import { ConfigurationService } from "../../../configuration-base";
import { CryptoError } from "../../../../lib/crypto";
import { getLogger } from "../../../../lib/logger-factory";
import {
  GoogleDriveOAuthClient,
  type GoogleDriveTokenSet,
} from "./google-drive-oauth-client";
import type { ValidationResult, ServiceHealthStatus } from "@mini-infra/types";

const log = () => getLogger("integrations", "google-drive-token-manager");

/** Refresh tokens this many ms before they actually expire. */
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

/** Setting keys under category "storage-google-drive". */
export const DRIVE_SETTING_KEYS = {
  CLIENT_ID: "client_id",
  CLIENT_SECRET: "client_secret",
  ACCESS_TOKEN: "access_token",
  REFRESH_TOKEN: "refresh_token",
  TOKEN_EXPIRY: "token_expiry",
  ACCOUNT_EMAIL: "account_email",
} as const;

export interface DriveOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface DriveTokenSnapshot {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: Date | null;
  accountEmail: string | null;
}

/**
 * Configuration helper bound to category="storage-google-drive". The methods
 * here are called from both the OAuth route and the Drive backend; the
 * concrete `StorageBackend` implementation composes this manager with the
 * `GoogleDriveOAuthClient`.
 */
export class GoogleDriveTokenManager extends ConfigurationService {
  constructor(prisma: PrismaClient) {
    super(prisma, "storage-google-drive");
  }

  /**
   * Connectivity rows for the Drive provider live under `service="storage"`
   * (matching the Azure backend) so the storage page indicator reads a single
   * row regardless of the active provider.
   */
  protected async recordConnectivityStatus(
    status: import("@mini-infra/types").ConnectivityStatusType,
    responseTimeMs?: number,
    errorMessage?: string,
    errorCode?: string,
    metadata?: Record<string, unknown>,
    userId?: string,
  ): Promise<void> {
    try {
      await this.prisma.connectivityStatus.create({
        data: {
          service: "storage",
          status,
          responseTimeMs: responseTimeMs ?? null,
          errorMessage: errorMessage ?? null,
          errorCode: errorCode ?? null,
          metadata: metadata ? JSON.stringify(metadata) : null,
          checkInitiatedBy: userId ?? null,
          checkedAt: new Date(),
          lastSuccessfulAt: status === "connected" ? new Date() : null,
        },
      });
    } catch (error) {
      log().error(
        {
          status,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to record storage connectivity status",
      );
    }
  }

  /** Read the BYO OAuth credentials. Returns null when not configured. */
  async getOAuthCredentials(): Promise<DriveOAuthCredentials | null> {
    const clientId = await this.get(DRIVE_SETTING_KEYS.CLIENT_ID);
    if (!clientId) return null;
    let clientSecret: string | null;
    try {
      clientSecret = await this.getSecure(DRIVE_SETTING_KEYS.CLIENT_SECRET);
    } catch (error) {
      if (error instanceof CryptoError) {
        log().error(
          { error: error.message },
          "Failed to decrypt Google Drive client_secret",
        );
        return null;
      }
      throw error;
    }
    if (!clientSecret) return null;
    return { clientId, clientSecret };
  }

  /** Persist BYO OAuth credentials. The secret is encrypted at rest. */
  async setOAuthCredentials(
    credentials: DriveOAuthCredentials,
    userId: string,
  ): Promise<void> {
    if (!credentials.clientId.trim()) {
      throw new Error("Google OAuth client_id is required");
    }
    if (!credentials.clientSecret.trim()) {
      throw new Error("Google OAuth client_secret is required");
    }
    await this.set(DRIVE_SETTING_KEYS.CLIENT_ID, credentials.clientId, userId);
    await this.setSecure(
      DRIVE_SETTING_KEYS.CLIENT_SECRET,
      credentials.clientSecret,
      userId,
    );
  }

  /** Wipe all persisted Drive config — credentials, tokens, account email. */
  async clearAll(userId: string): Promise<void> {
    for (const key of Object.values(DRIVE_SETTING_KEYS)) {
      try {
        await super.delete(key, userId);
      } catch {
        // OK if not present — `delete` throws on missing rows.
      }
    }
    await this.recordConnectivityStatus(
      "failed",
      undefined,
      "Google Drive provider disconnected",
      "DISCONNECTED",
      undefined,
      userId,
    );
  }

  /** Wipe just the OAuth tokens (keeps client_id + secret). */
  async clearTokens(userId: string): Promise<void> {
    for (const key of [
      DRIVE_SETTING_KEYS.ACCESS_TOKEN,
      DRIVE_SETTING_KEYS.REFRESH_TOKEN,
      DRIVE_SETTING_KEYS.TOKEN_EXPIRY,
      DRIVE_SETTING_KEYS.ACCOUNT_EMAIL,
    ]) {
      try {
        await super.delete(key, userId);
      } catch {
        // OK if not present.
      }
    }
  }

  /** Persist a token set freshly minted from Google. */
  async storeTokens(
    tokens: GoogleDriveTokenSet,
    userId: string,
  ): Promise<void> {
    await this.setSecure(
      DRIVE_SETTING_KEYS.ACCESS_TOKEN,
      tokens.accessToken,
      userId,
    );
    if (tokens.refreshToken) {
      await this.setSecure(
        DRIVE_SETTING_KEYS.REFRESH_TOKEN,
        tokens.refreshToken,
        userId,
      );
    }
    await this.set(
      DRIVE_SETTING_KEYS.TOKEN_EXPIRY,
      tokens.expiryDate.toISOString(),
      userId,
    );
  }

  /** Persist the connected operator's email. */
  async setAccountEmail(email: string, userId: string): Promise<void> {
    await this.set(DRIVE_SETTING_KEYS.ACCOUNT_EMAIL, email, userId);
  }

  /** Snapshot of stored tokens. Returns null when the access token is gone. */
  async getStoredTokens(): Promise<DriveTokenSnapshot | null> {
    let accessToken: string | null;
    try {
      accessToken = await this.getSecure(DRIVE_SETTING_KEYS.ACCESS_TOKEN);
    } catch (error) {
      if (error instanceof CryptoError) {
        log().error(
          { error: error.message },
          "Failed to decrypt Google Drive access_token",
        );
        await this.recordConnectivityStatus(
          "failed",
          undefined,
          "Stored Google Drive token could not be decrypted",
          "TOKEN_DECRYPT_FAILED",
        );
        return null;
      }
      throw error;
    }
    if (!accessToken) return null;
    let refreshToken: string | null = null;
    try {
      refreshToken = await this.getSecure(DRIVE_SETTING_KEYS.REFRESH_TOKEN);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      // Treat decrypt failure as "no refresh token" — manager will surface
      // unauthorized below if it can't refresh.
      log().warn(
        { error: error.message },
        "Failed to decrypt Google Drive refresh_token, treating as missing",
      );
    }
    const expiryRaw = await this.get(DRIVE_SETTING_KEYS.TOKEN_EXPIRY);
    const accountEmail = await this.get(DRIVE_SETTING_KEYS.ACCOUNT_EMAIL);
    return {
      accessToken,
      refreshToken,
      expiryDate: expiryRaw ? new Date(expiryRaw) : null,
      accountEmail: accountEmail ?? null,
    };
  }

  /**
   * True if the provider is configured AND has stored tokens. Used by the
   * settings route to decide whether to surface "Connect" or "Connected".
   */
  async isConfigured(): Promise<boolean> {
    const creds = await this.getOAuthCredentials();
    if (!creds) return false;
    const snapshot = await this.getStoredTokens();
    return snapshot !== null;
  }

  /**
   * Build an OAuth client from stored BYO credentials + the supplied redirect
   * URI. Returns null when the operator hasn't configured client credentials.
   */
  async buildOAuthClient(
    redirectUri: string,
  ): Promise<GoogleDriveOAuthClient | null> {
    const creds = await this.getOAuthCredentials();
    if (!creds) return null;
    return new GoogleDriveOAuthClient(
      creds.clientId,
      creds.clientSecret,
      redirectUri,
    );
  }

  /**
   * Return a fresh access token, refreshing 5 minutes before expiry. Returns
   * null (without throwing) when:
   *  - the provider isn't configured
   *  - tokens are missing
   *  - decryption failed
   *  - the refresh attempt failed (e.g. token revoked)
   *
   * In each null path the manager records an "unauthorized" / "failed"
   * connectivity row so the UI can show the Reconnect CTA.
   */
  async getValidAccessToken(
    redirectUri: string,
    userId: string = "system",
  ): Promise<string | null> {
    const snapshot = await this.getStoredTokens();
    if (!snapshot) return null;

    // Fast path: token still has plenty of life left.
    const now = Date.now();
    const expiry = snapshot.expiryDate?.getTime() ?? 0;
    if (expiry - now > REFRESH_LEEWAY_MS) {
      return snapshot.accessToken;
    }

    if (!snapshot.refreshToken) {
      log().warn(
        "Google Drive access token near expiry but no refresh token stored",
      );
      await this.recordConnectivityStatus(
        "failed",
        undefined,
        "Google Drive token expired and no refresh token is available — reconnect required",
        "REFRESH_TOKEN_MISSING",
      );
      return null;
    }

    const oauthClient = await this.buildOAuthClient(redirectUri);
    if (!oauthClient) {
      await this.recordConnectivityStatus(
        "failed",
        undefined,
        "Google Drive client credentials missing while refreshing token",
        "CLIENT_CREDENTIALS_MISSING",
      );
      return null;
    }

    try {
      const refreshed = await oauthClient.refreshAccessToken(
        snapshot.refreshToken,
      );
      await this.storeTokens(refreshed, userId);
      log().info(
        { expiryDate: refreshed.expiryDate.toISOString() },
        "Google Drive access token refreshed",
      );
      return refreshed.accessToken;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      log().warn({ error: message }, "Failed to refresh Google Drive token");
      await this.recordConnectivityStatus(
        "failed",
        undefined,
        `Failed to refresh Google Drive token: ${message}`,
        "TOKEN_REFRESH_FAILED",
      );
      return null;
    }
  }

  /**
   * `validate` here is intentionally a no-op stub: the Drive backend's
   * `validate()` calls `drive.about.get()` against a live token, and there's
   * no point validating the manager separately. We keep the abstract method
   * satisfied so this class can lean on the base helpers.
   */
  async validate(): Promise<ValidationResult> {
    return {
      isValid: true,
      message: "GoogleDriveTokenManager has no standalone validation",
      responseTimeMs: 0,
    };
  }

  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latest = await this.getLatestConnectivityStatus();
    if (!latest) {
      return {
        service: "storage",
        status: "failed",
        lastChecked: new Date(),
      };
    }
    return {
      service: "storage",
      status: latest.status as ServiceHealthStatus["status"],
      lastChecked: latest.checkedAt,
      lastSuccessful: latest.lastSuccessfulAt,
      responseTime: latest.responseTimeMs,
      errorMessage: latest.errorMessage,
      errorCode: latest.errorCode,
      metadata: latest.metadata ? JSON.parse(latest.metadata) : undefined,
    };
  }
}
