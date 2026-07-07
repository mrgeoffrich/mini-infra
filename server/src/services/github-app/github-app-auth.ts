import jwt from "jsonwebtoken";
import { ErrorCode } from "@mini-infra/types";
import { ValidationError } from "../../lib/errors";
import {
  GITHUB_API_BASE,
  SETTING_KEYS,
  GitHubAppContext,
  githubApiFailure,
} from "./github-app-constants";

/**
 * Handles GitHub App JWT generation and installation token creation.
 */
export class GitHubAppAuth {
  constructor(private ctx: GitHubAppContext) {}

  /**
   * Generate a JWT for GitHub App authentication.
   * The JWT is signed with the App's private key using RS256.
   *
   * @param appId - Optional app ID override (used during setup before settings are stored)
   * @param privateKey - Optional private key override (used during setup)
   * @returns Signed JWT string
   */
  generateJWT(appId?: string, privateKey?: string): string {
    const issuer = appId;
    const key = privateKey;

    if (!issuer || !key) {
      throw new ValidationError(
        ErrorCode.GITHUB_APP_NOT_CONFIGURED,
        "GitHub App is not configured: missing app_id or private_key",
        {
          resource: { type: "githubApp" },
          action: "Configure the GitHub App in Settings > GitHub.",
        },
      );
    }

    const now = Math.floor(Date.now() / 1000);

    const payload = {
      iss: issuer,
      iat: now - 60, // Issued 60 seconds in the past to account for clock drift
      exp: now + 600, // Expires in 10 minutes (GitHub maximum)
    };

    return jwt.sign(payload, key, { algorithm: "RS256" });
  }

  /**
   * Generate a JWT using stored credentials.
   * Convenience wrapper around generateJWT that loads settings from the database.
   *
   * @returns Signed JWT string
   */
  async generateStoredJWT(): Promise<string> {
    const appId = await this.ctx.getSetting(SETTING_KEYS.APP_ID);
    const privateKey = await this.ctx.getSetting(SETTING_KEYS.PRIVATE_KEY);

    if (!appId || !privateKey) {
      throw new ValidationError(
        ErrorCode.GITHUB_APP_NOT_CONFIGURED,
        "GitHub App is not configured: missing app_id or private_key",
        {
          resource: { type: "githubApp" },
          action: "Configure the GitHub App in Settings > GitHub.",
        },
      );
    }

    return this.generateJWT(appId, privateKey);
  }

  /**
   * Generate an installation access token for GitHub API calls.
   * Installation tokens have the permissions granted to the App
   * and are scoped to the specific installation.
   *
   * @returns Object containing the token and its expiry time
   */
  async generateInstallationToken(): Promise<{
    token: string;
    expiresAt: string;
  }> {
    const installationId = await this.ctx.getSetting(SETTING_KEYS.INSTALLATION_ID);

    if (!installationId) {
      throw new ValidationError(
        ErrorCode.GITHUB_APP_NOT_INSTALLED,
        "GitHub App is not configured: missing installation_id",
        {
          resource: { type: "githubApp" },
          action: "Install the GitHub App on your account or organization, then refresh the installation status.",
        },
      );
    }

    const appJwt = await this.generateStoredJWT();

    const response = await this.ctx.fetchGitHub(
      `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${appJwt}`,
        },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw githubApiFailure("generate installation token", response, errorBody);
    }

    const data = await response.json();

    this.ctx.logger.debug(
      { expiresAt: data.expires_at },
      "Generated GitHub App installation token",
    );

    return {
      token: data.token,
      expiresAt: data.expires_at,
    };
  }
}
