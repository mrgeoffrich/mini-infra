import { PrismaClient } from "../../lib/prisma";
import { RegistryCredentialService } from "../registry-credential";
import { GITHUB_API_BASE, SETTING_KEYS, GitHubAppContext } from "./github-app-constants";
import { GitHubAppAuth } from "./github-app-auth";

/**
 * Handles GitHub App manifest flow registration, setup completion,
 * installation refresh, and GHCR credential management.
 */
export class GitHubAppSetup {
  constructor(
    private ctx: GitHubAppContext,
    private auth: GitHubAppAuth,
    private prisma: PrismaClient,
  ) {}

  /**
   * Generate a GitHub App manifest for the manifest flow registration.
   * This manifest is POSTed to GitHub to create a new GitHub App.
   *
   * @param callbackUrl - The URL GitHub should redirect to after app creation
   * @returns The manifest object to be POSTed to GitHub
   */
  generateManifest(callbackUrl: string): object {
    const randomSuffix = Math.random().toString(36).substring(2, 8);

    return {
      name: `mini-infra-${randomSuffix}`,
      url: callbackUrl,
      callback_urls: [callbackUrl],
      redirect_url: callbackUrl,
      public: false,
      default_events: [],
      default_permissions: {
        packages: "read",
        actions: "read",
        contents: "read",
        metadata: "read",
      },
    };
  }

  /**
   * Complete the GitHub App manifest flow by exchanging the temporary code
   * for the App credentials, then discover installations and set up GHCR.
   *
   * @param code - Temporary code from GitHub's redirect after manifest creation
   * @param userId - The user performing the setup (for audit trails)
   * @returns Object containing the app slug and owner
   */
  async completeSetup(
    code: string,
    userId: string,
  ): Promise<{ appSlug: string; owner: string }> {
    this.ctx.logger.info("Starting GitHub App manifest code exchange");

    // Step 1: Exchange the code for app credentials
    const conversionResponse = await this.ctx.fetchGitHub(
      `${GITHUB_API_BASE}/app-manifests/${code}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!conversionResponse.ok) {
      const errorBody = await conversionResponse.text();
      throw new Error(
        `GitHub App manifest conversion failed (${conversionResponse.status}): ${errorBody}`,
      );
    }

    const appData = await conversionResponse.json();

    this.ctx.logger.info(
      { appSlug: appData.slug, appId: appData.id },
      "GitHub App created from manifest",
    );

    // Step 2: Store all credentials
    const ownerLogin = appData.owner?.login || "";
    const ownerType = appData.owner?.type || "User";

    await Promise.all([
      this.ctx.setSetting(SETTING_KEYS.APP_ID, String(appData.id), userId),
      this.ctx.setSetting(SETTING_KEYS.PRIVATE_KEY, appData.pem, userId),
      this.ctx.setSetting(
        SETTING_KEYS.WEBHOOK_SECRET,
        appData.webhook_secret || "",
        userId,
      ),
      this.ctx.setSetting(SETTING_KEYS.APP_SLUG, appData.slug, userId),
      this.ctx.setSetting(SETTING_KEYS.OWNER, ownerLogin, userId),
      this.ctx.setSetting(SETTING_KEYS.OWNER_TYPE, ownerType, userId),
      this.ctx.setSetting(SETTING_KEYS.CLIENT_ID, appData.client_id || "", userId),
      this.ctx.setSetting(SETTING_KEYS.CLIENT_SECRET, appData.client_secret || "", userId),
    ]);

    // Step 3: Find and store installation ID
    try {
      const appJwt = this.auth.generateJWT(String(appData.id), appData.pem);

      const installationsResponse = await this.ctx.fetchGitHub(
        `${GITHUB_API_BASE}/app/installations`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${appJwt}`,
          },
        },
      );

      if (installationsResponse.ok) {
        const installations = await installationsResponse.json();
        if (installations.length > 0) {
          const installationId = String(installations[0].id);
          await this.ctx.setSetting(SETTING_KEYS.INSTALLATION_ID, installationId, userId);

          // Store permissions from the installation
          const permissions = installations[0].permissions || {};
          await this.ctx.setSetting(
            SETTING_KEYS.PERMISSIONS,
            JSON.stringify(permissions),
            userId,
          );

          this.ctx.logger.info(
            { installationId, permissionCount: Object.keys(permissions).length },
            "GitHub App installation found and stored",
          );
        } else {
          this.ctx.logger.warn(
            "No installations found for newly created GitHub App",
          );
        }
      } else {
        this.ctx.logger.warn(
          { status: installationsResponse.status },
          "Failed to fetch installations after app creation",
        );
      }
    } catch (installError) {
      this.ctx.logger.error(
        {
          error:
            installError instanceof Error
              ? installError.message
              : String(installError),
        },
        "Error finding installations, continuing setup",
      );
    }

    // Step 4: Auto-create GHCR registry credential
    try {
      await this.createOrUpdateGhcrCredential(userId);
    } catch (ghcrError) {
      this.ctx.logger.warn(
        {
          error:
            ghcrError instanceof Error
              ? ghcrError.message
              : String(ghcrError),
        },
        "Failed to auto-create GHCR credential, can be done manually later",
      );
    }

    return {
      appSlug: appData.slug,
      owner: ownerLogin,
    };
  }

  /**
   * Re-check GitHub for app installations. Called after the user installs
   * the app on their account/org via the GitHub UI.
   *
   * @param userId - The user performing the refresh (for audit trails)
   * @returns Whether an installation was found and stored
   */
  async refreshInstallation(userId: string): Promise<{ found: boolean; installationId?: string }> {
    const appId = await this.ctx.getSetting(SETTING_KEYS.APP_ID);
    const privateKey = await this.ctx.getSetting(SETTING_KEYS.PRIVATE_KEY);

    if (!appId || !privateKey) {
      throw new Error("GitHub App not configured - missing app ID or private key");
    }

    const appJwt = this.auth.generateJWT(appId, privateKey);

    const installationsResponse = await this.ctx.fetchGitHub(
      `${GITHUB_API_BASE}/app/installations`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${appJwt}`,
        },
      },
    );

    if (!installationsResponse.ok) {
      throw new Error(`Failed to fetch installations (${installationsResponse.status})`);
    }

    const installations = await installationsResponse.json();
    if (installations.length === 0) {
      return { found: false };
    }

    const installationId = String(installations[0].id);
    await this.ctx.setSetting(SETTING_KEYS.INSTALLATION_ID, installationId, userId);

    const permissions = installations[0].permissions || {};
    await this.ctx.setSetting(SETTING_KEYS.PERMISSIONS, JSON.stringify(permissions), userId);

    this.ctx.logger.info(
      { installationId, permissionCount: Object.keys(permissions).length },
      "GitHub App installation found and stored via refresh",
    );

    // Now that we have an installation, auto-create GHCR credential
    try {
      await this.createOrUpdateGhcrCredential(userId);
    } catch (ghcrError) {
      this.ctx.logger.warn(
        { error: ghcrError instanceof Error ? ghcrError.message : String(ghcrError) },
        "Failed to auto-create GHCR credential after installation refresh",
      );
    }

    return { found: true, installationId };
  }

  /**
   * Create or update a GHCR (GitHub Container Registry) credential.
   * Uses the installation token as the password with username "x-access-token".
   *
   * @param userId - The user performing the operation (for audit trails)
   */
  async createOrUpdateGhcrCredential(userId: string): Promise<void> {
    const { token, expiresAt } = await this.auth.generateInstallationToken();

    const registryCredentialService = new RegistryCredentialService(this.prisma);

    // Check if any GHCR credential already exists (by registryUrl, regardless of name)
    const existingCredentials =
      await registryCredentialService.getAllCredentials();
    const existingGhcr = existingCredentials.find(
      (c) => c.registryUrl === "ghcr.io",
    );

    if (existingGhcr) {
      // Update existing credential with new token
      await registryCredentialService.updateCredential(
        existingGhcr.id,
        {
          username: "x-access-token",
          password: token,
          description: `Auto-managed by GitHub App. Token expires at ${expiresAt}`,
        },
        userId,
      );

      this.ctx.logger.info(
        { credentialId: existingGhcr.id, expiresAt },
        "Updated GHCR credential with new installation token",
      );
    } else {
      // Create new GHCR credential
      const credential = await registryCredentialService.createCredential(
        {
          name: "GitHub App (auto-managed)",
          registryUrl: "ghcr.io",
          username: "x-access-token",
          password: token,
          description: `Auto-managed by GitHub App. Token expires at ${expiresAt}`,
          isDefault: false,
        },
        userId,
      );

      this.ctx.logger.info(
        { credentialId: credential.id, expiresAt },
        "Created GHCR credential from GitHub App installation token",
      );
    }
  }
}
