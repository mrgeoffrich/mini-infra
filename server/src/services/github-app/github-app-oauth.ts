import crypto from "crypto";
import { GitHubAppOAuthStatus } from "@mini-infra/types";
import { SETTING_KEYS, GitHubAppContext } from "./github-app-constants";

/**
 * Handles GitHub OAuth user-to-server token flows:
 * authorization URL generation, code exchange, token refresh, and status.
 */
export class GitHubAppOAuth {
  constructor(private ctx: GitHubAppContext) {}

  /**
   * Generate the GitHub OAuth authorization URL.
   * The user should be redirected to this URL to authorize the app.
   *
   * No redirect_uri is specified — GitHub will use the first registered
   * callback URL from the App settings (same URL used by the manifest flow).
   * The frontend handles the callback code and POSTs it to the backend.
   *
   * @returns The authorization URL and state parameter
   */
  async generateOAuthAuthorizeUrl(): Promise<{ authorizeUrl: string; state: string }> {
    const clientId = await this.ctx.getSetting(SETTING_KEYS.CLIENT_ID);
    if (!clientId) {
      throw new Error("GitHub App client_id not configured");
    }

    const state = crypto.randomBytes(20).toString("hex");

    const params = new URLSearchParams({
      client_id: clientId,
      state,
    });

    return {
      authorizeUrl: `https://github.com/login/oauth/authorize?${params.toString()}`,
      state,
    };
  }

  /**
   * Exchange an OAuth authorization code for a user access token.
   * Stores the access token, refresh token, and expiration in settings.
   *
   * @param code - The authorization code from GitHub's callback
   * @param userId - The user performing the action (for audit)
   */
  async exchangeOAuthCode(code: string, userId: string): Promise<void> {
    const clientId = await this.ctx.getSetting(SETTING_KEYS.CLIENT_ID);
    const clientSecret = await this.ctx.getSetting(SETTING_KEYS.CLIENT_SECRET);

    if (!clientId || !clientSecret) {
      throw new Error("GitHub App OAuth credentials not configured");
    }

    const response = await this.ctx.fetchGitHub(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OAuth token exchange failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`OAuth error: ${data.error_description || data.error}`);
    }

    if (!data.access_token) {
      throw new Error("OAuth response missing access_token");
    }

    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // Default 8h

    await Promise.all([
      this.ctx.setSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN, data.access_token, userId),
      this.ctx.setSetting(SETTING_KEYS.OAUTH_EXPIRES_AT, expiresAt, userId),
      ...(data.refresh_token
        ? [this.ctx.setSetting(SETTING_KEYS.OAUTH_REFRESH_TOKEN, data.refresh_token, userId)]
        : []),
    ]);

    this.ctx.logger.info(
      { expiresAt, hasRefreshToken: !!data.refresh_token },
      "OAuth user access token stored",
    );
  }

  /**
   * Refresh the OAuth user access token using the stored refresh token.
   *
   * @param userId - The user performing the action (for audit)
   */
  async refreshOAuthToken(userId: string): Promise<void> {
    const clientId = await this.ctx.getSetting(SETTING_KEYS.CLIENT_ID);
    const clientSecret = await this.ctx.getSetting(SETTING_KEYS.CLIENT_SECRET);
    const refreshToken = await this.ctx.getSetting(SETTING_KEYS.OAUTH_REFRESH_TOKEN);

    if (!clientId || !clientSecret) {
      throw new Error("GitHub App OAuth credentials not configured");
    }

    if (!refreshToken) {
      throw new Error("No OAuth refresh token available — user must re-authorize");
    }

    const response = await this.ctx.fetchGitHub(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OAuth token refresh failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json();

    if (data.error) {
      // If refresh fails, clear the stored tokens so user can re-authorize
      if (data.error === "bad_refresh_token") {
        await Promise.all([
          this.ctx.deleteSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN, userId),
          this.ctx.deleteSetting(SETTING_KEYS.OAUTH_REFRESH_TOKEN, userId),
          this.ctx.deleteSetting(SETTING_KEYS.OAUTH_EXPIRES_AT, userId),
        ]);
      }
      throw new Error(`OAuth refresh error: ${data.error_description || data.error}`);
    }

    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

    await Promise.all([
      this.ctx.setSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN, data.access_token, userId),
      this.ctx.setSetting(SETTING_KEYS.OAUTH_EXPIRES_AT, expiresAt, userId),
      ...(data.refresh_token
        ? [this.ctx.setSetting(SETTING_KEYS.OAUTH_REFRESH_TOKEN, data.refresh_token, userId)]
        : []),
    ]);

    this.ctx.logger.info({ expiresAt }, "OAuth user access token refreshed");
  }

  /**
   * Get a valid OAuth user access token, auto-refreshing if expired.
   * Returns null if no OAuth token is configured.
   */
  async getValidOAuthToken(userId: string = "system"): Promise<string | null> {
    const token = await this.ctx.getSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN);
    if (!token) return null;

    const expiresAt = await this.ctx.getSetting(SETTING_KEYS.OAUTH_EXPIRES_AT);
    if (expiresAt) {
      const expiry = new Date(expiresAt);
      // Refresh if within 5 minutes of expiry
      if (expiry.getTime() - Date.now() < 5 * 60 * 1000) {
        try {
          await this.refreshOAuthToken(userId);
          return await this.ctx.getSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN);
        } catch (error) {
          this.ctx.logger.warn(
            { error: error instanceof Error ? error.message : "Unknown" },
            "Failed to refresh OAuth token",
          );
          return null;
        }
      }
    }

    return token;
  }

  /**
   * Get the current OAuth authorization status.
   */
  async getOAuthStatus(): Promise<GitHubAppOAuthStatus> {
    const token = await this.ctx.getSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN);
    const expiresAt = await this.ctx.getSetting(SETTING_KEYS.OAUTH_EXPIRES_AT);

    const isAuthorized = !!token;
    const isExpired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;

    return {
      isAuthorized,
      expiresAt: expiresAt || null,
      isExpired: isAuthorized && isExpired,
    };
  }
}
