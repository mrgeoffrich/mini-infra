/**
 * Thin wrapper around `googleapis` `OAuth2Client` for the Storage / Google
 * Drive provider's OAuth flow.
 *
 * The class deliberately holds *no* persistent state — every token-refresh or
 * authorize-URL build is constructed from the operator's BYO Client ID +
 * Client Secret + the canonical redirect URI built off `getPublicUrl()`. The
 * `GoogleDriveTokenManager` keeps tokens in `system_settings`; this client
 * only knows how to talk to Google.
 *
 * We do NOT reuse `passport-google-oauth20` here — that's wired to the
 * user-login `User` table and storage OAuth is a separate concern (different
 * scope, different token lifecycle, different storage).
 */

import { google, Auth } from "googleapis";

/** Minimum scope needed for app-created Drive folders/files. */
export const GOOGLE_DRIVE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
] as const;

export interface GoogleDriveTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiryDate: Date;
}

export class GoogleDriveOAuthClient {
  private readonly oauth2: Auth.OAuth2Client;

  constructor(
    readonly clientId: string,
    readonly clientSecret: string,
    readonly redirectUri: string,
  ) {
    this.oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /**
   * Build the Google authorize URL. Caller passes their own opaque, signed
   * `state` string — Google echoes it on the callback so the route can
   * verify the response is genuinely tied to a request it issued.
   *
   * `access_type=offline` + `prompt=consent` ensures Google issues a refresh
   * token on first authorize (Google otherwise reuses an existing grant and
   * skips the refresh token, which would leave us unable to refresh).
   */
  generateAuthUrl(state: string): string {
    // We deliberately do NOT pass `include_granted_scopes: true` — that flag
    // tells Google to silently expand the granted scopes to whatever else
    // the operator has previously approved for this client ID. We want the
    // returned token to carry exactly `drive.file` and nothing more.
    return this.oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [...GOOGLE_DRIVE_OAUTH_SCOPES],
      state,
    });
  }

  /**
   * Exchange an authorization code for an access + refresh token. Returns the
   * normalised token set; storing it is the caller's job.
   */
  async exchangeCodeForTokens(code: string): Promise<GoogleDriveTokenSet> {
    const { tokens } = await this.oauth2.getToken(code);
    if (!tokens.access_token) {
      throw new Error("Google OAuth response missing access_token");
    }
    const expiryDate = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + 60 * 60 * 1000);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? undefined,
      expiryDate,
    };
  }

  /**
   * Refresh an access token using a stored refresh token. Google may rotate
   * the refresh token itself — the returned set carries whichever
   * `refresh_token` Google sent back.
   */
  async refreshAccessToken(refreshToken: string): Promise<GoogleDriveTokenSet> {
    this.oauth2.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await this.oauth2.refreshAccessToken();
    if (!credentials.access_token) {
      throw new Error("Google OAuth refresh response missing access_token");
    }
    const expiryDate = credentials.expiry_date
      ? new Date(credentials.expiry_date)
      : new Date(Date.now() + 60 * 60 * 1000);
    return {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token ?? refreshToken,
      expiryDate,
    };
  }

  /**
   * Build a short-lived `OAuth2Client` with credentials set, suitable for
   * passing to `google.drive({ version: "v3", auth })` calls. The caller is
   * responsible for passing an access token that's known to be fresh — wire
   * via {@link GoogleDriveTokenManager.getValidAccessToken}.
   */
  withAccessToken(accessToken: string): Auth.OAuth2Client {
    const c = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri,
    );
    c.setCredentials({ access_token: accessToken });
    return c;
  }
}
