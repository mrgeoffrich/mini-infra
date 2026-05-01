/**
 * Google Drive OAuth flow for the Storage provider.
 *
 * Endpoints (mounted under `/api/storage/google-drive/oauth`):
 *   GET /start    — requires `storage:write`. Builds the Google authorize URL
 *                   from BYO client credentials + the canonical redirect URI
 *                   from `getPublicUrl()`. Returns a 302 redirect.
 *   GET /callback — Google redirects here with `code` and `state`. Verifies
 *                   the HMAC-signed state, exchanges code → tokens, stores
 *                   them encrypted, fetches `about.get` for the operator
 *                   email, and redirects back to `/connectivity-storage` with
 *                   `?google-drive=connected` (or `?google-drive=error&reason=…`).
 *
 * The state is stateless HMAC-signed (10 min TTL) — no SystemSettings
 * round-trip means concurrent OAuth attempts can't race on a shared nonce.
 */

import express, {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { getLogger } from "../lib/logger-factory";
import { getAuthenticatedUser, requirePermission } from "../middleware/auth";
import prisma from "../lib/prisma";
import { GoogleDriveTokenManager } from "../services/storage/providers/google-drive/google-drive-token-manager";
import {
  buildGoogleDriveRedirectUri,
  GoogleDrivePublicUrlNotConfiguredError,
} from "../services/storage/providers/google-drive/google-drive-redirect";
import {
  buildOAuthState,
  OAuthStateInvalidError,
  verifyOAuthState,
} from "../services/storage/providers/google-drive/google-drive-oauth-state";
import { google } from "googleapis";
import { StorageService } from "../services/storage/storage-service";

const logger = getLogger("integrations", "storage-google-drive-oauth");
const router = express.Router();

const POST_REDIRECT_PATH = "/connectivity-storage";

function buildPostRedirect(qs: string): string {
  return `${POST_REDIRECT_PATH}?${qs}`;
}

function buildErrorRedirect(reason: string): string {
  return buildPostRedirect(
    `google-drive=error&reason=${encodeURIComponent(reason)}`,
  );
}

router.get(
  "/start",
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
        redirectUri = await buildGoogleDriveRedirectUri();
      } catch (error) {
        if (error instanceof GoogleDrivePublicUrlNotConfiguredError) {
          return res.status(400).json({
            success: false,
            error: error.message,
            errorCode: error.code,
          });
        }
        throw error;
      }
      const oauthClient = await tokens.buildOAuthClient(redirectUri);
      if (!oauthClient) {
        // Shouldn't happen — credentials exist by the time we reach this — but
        // keep the type guard.
        return res.status(500).json({
          success: false,
          error: "Failed to build Drive OAuth client",
        });
      }
      const state = buildOAuthState();
      const authorizeUrl = oauthClient.generateAuthUrl(state);
      logger.info(
        { userId: user.id, redirectUri },
        "Issuing Google Drive authorize redirect",
      );
      // 302 redirect — frontend Connect button will hit this URL via a
      // top-level navigation so Google's consent screen renders directly.
      return res.redirect(302, authorizeUrl);
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
);

router.get(
  "/callback",
  // No requirePermission — Google initiates the call. We rely on HMAC state
  // verification to confirm the response came from a request we issued.
  // (Cookies are also still in scope so the user remains authenticated when
  // the callback eventually redirects them to the SPA.)
  (async (req: Request, res: Response) => {
    const stateRaw =
      typeof req.query.state === "string" ? req.query.state : undefined;
    const code =
      typeof req.query.code === "string" ? req.query.code : undefined;
    const errorParam =
      typeof req.query.error === "string" ? req.query.error : undefined;

    if (errorParam) {
      logger.warn(
        { error: errorParam },
        "Google denied Drive authorization",
      );
      return res.redirect(302, buildErrorRedirect(errorParam));
    }

    try {
      verifyOAuthState(stateRaw);
    } catch (error) {
      const reason =
        error instanceof OAuthStateInvalidError ? error.code : "invalid_state";
      logger.warn(
        {
          reason,
          message: error instanceof Error ? error.message : "Unknown error",
        },
        "Google Drive OAuth state verification failed",
      );
      return res.redirect(302, buildErrorRedirect(reason));
    }

    if (!code) {
      logger.warn("Google Drive OAuth callback missing 'code'");
      return res.redirect(302, buildErrorRedirect("missing_code"));
    }

    try {
      const tokens = new GoogleDriveTokenManager(prisma);
      const credentials = await tokens.getOAuthCredentials();
      if (!credentials) {
        return res.redirect(
          302,
          buildErrorRedirect("client_credentials_missing"),
        );
      }
      const redirectUri = await buildGoogleDriveRedirectUri();
      const oauthClient = await tokens.buildOAuthClient(redirectUri);
      if (!oauthClient) {
        return res.redirect(
          302,
          buildErrorRedirect("client_credentials_missing"),
        );
      }
      const tokenSet = await oauthClient.exchangeCodeForTokens(code);

      // Persist tokens BEFORE calling about.get — the about call uses them.
      // The user id "system" here is fine: this is an audit trail for the
      // setting row, not the user identity for the OAuth grant.
      const userId = getAuthenticatedUser(req)?.id ?? "system";
      await tokens.storeTokens(tokenSet, userId);

      try {
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: tokenSet.accessToken });
        const drive = google.drive({ version: "v3", auth });
        const about = await drive.about.get({ fields: "user" });
        const email = about.data.user?.emailAddress;
        if (email) {
          await tokens.setAccountEmail(email, userId);
        }
        // Record connectivity now that the round-trip succeeded. We call
        // validate() against the freshly-instantiated backend so the row
        // carries the operator email + responseTime.
        const backend = StorageService.getInstance(
          prisma,
        ).getBackendByProviderId("google-drive");
        await backend.validate();
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Failed to fetch about.user after token exchange (tokens still stored)",
        );
      }

      logger.info(
        { userId },
        "Google Drive OAuth flow completed; tokens stored",
      );
      return res.redirect(302, buildPostRedirect("google-drive=connected"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Google Drive code exchange failed");
      const reason = message.toLowerCase().includes("redirect_uri")
        ? "redirect_uri_mismatch"
        : "exchange_failed";
      return res.redirect(302, buildErrorRedirect(reason));
    }
  }) as RequestHandler,
);

export default router;
