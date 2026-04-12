import prisma, { PrismaClient } from "../../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  GitHubAppSettingResponse,
  GitHubAppPackage,
  GitHubAppPackageVersion,
  GitHubAppRepository,
  GitHubAppActionsRun,
  GitHubAppOAuthStatus,
  GitHubAgentAccessStatus,
  GitHubAgentAccessLevel,
} from "@mini-infra/types";
import { ConfigurationService } from "../configuration-base";
import { servicesLogger } from "../../lib/logger-factory";
import { CircuitBreaker } from "../circuit-breaker";
import {
  GITHUB_APP_ERROR_MAPPERS,
  SETTING_KEYS,
  ALL_SETTING_KEYS,
  GitHubAppContext,
  GitHubAppValidationContext,
} from "./github-app-constants";
import { fetchGitHub } from "./github-app-http";
import { GitHubAppAuth } from "./github-app-auth";
import { GitHubAppOAuth } from "./github-app-oauth";
import { GitHubAppSetup } from "./github-app-setup";
import { GitHubAppResources } from "./github-app-resources";
import { GitHubAppValidation } from "./github-app-validation";

/**
 * GitHubAppService - Facade that preserves the original public API.
 *
 * Delegates to focused sub-modules for each responsibility area:
 * - GitHubAppAuth: JWT and installation token generation
 * - GitHubAppOAuth: OAuth user-to-server token flows
 * - GitHubAppSetup: Manifest flow, setup, installation, GHCR credentials
 * - GitHubAppResources: Package, repository, and actions run listing
 * - GitHubAppValidation: Validation, health, and config status
 *
 * Extends ConfigurationService for persistent settings storage
 * and implements circuit breaker pattern for resilient API communication.
 */
export class GitHubAppService extends ConfigurationService {
  private circuitBreaker: CircuitBreaker;
  private auth: GitHubAppAuth;
  private oauth: GitHubAppOAuth;
  private setup: GitHubAppSetup;
  private resources: GitHubAppResources;
  private validation: GitHubAppValidation;

  constructor(prismaClient: PrismaClient) {
    super(prismaClient, "github-app");

    this.circuitBreaker = new CircuitBreaker({
      serviceName: "GitHubApp",
      failureThreshold: 5,
      cooldownPeriodMs: 5 * 60 * 1000,
      dedupWindowMs: 1000,
      errorMappers: GITHUB_APP_ERROR_MAPPERS,
      defaultErrorCode: "GITHUB_APP_API_ERROR",
      tokenRedactPatterns: [
        /ghs_[a-zA-Z0-9]{36,}/g, // installation tokens
        /v[0-9]\.[0-9a-f]{40}/g, // GitHub App JWTs (rough match)
      ],
      sensitiveKeys: [
        "private_key",
        "privateKey",
        "webhook_secret",
        "webhookSecret",
        "client_secret",
        "clientSecret",
        "token",
        "secret",
        "password",
        "pem",
      ],
    });

    const ctx: GitHubAppContext = {
      getSetting: (key) => this.get(key),
      setSetting: (key, value, userId) => this.set(key, value, userId),
      deleteSetting: (key, userId) => this.delete(key, userId),
      fetchGitHub,
      logger: servicesLogger(),
    };

    const validationCtx: GitHubAppValidationContext = {
      ...ctx,
      circuitBreaker: this.circuitBreaker,
      recordConnectivityStatus: (...args) => this.recordConnectivityStatus(...args),
      getLatestConnectivityStatus: () => this.getLatestConnectivityStatus(),
    };

    this.auth = new GitHubAppAuth(ctx);
    this.oauth = new GitHubAppOAuth(ctx);
    this.setup = new GitHubAppSetup(ctx, this.auth);
    this.resources = new GitHubAppResources(ctx, this.auth, this.oauth);
    this.validation = new GitHubAppValidation(validationCtx, this.auth, this.oauth);
  }

  // --- Auth (delegated) ---

  generateJWT(appId?: string, privateKey?: string): string {
    return this.auth.generateJWT(appId, privateKey);
  }

  async generateStoredJWT(): Promise<string> {
    return this.auth.generateStoredJWT();
  }

  async generateInstallationToken(): Promise<{ token: string; expiresAt: string }> {
    return this.auth.generateInstallationToken();
  }

  // --- OAuth (delegated) ---

  async generateOAuthAuthorizeUrl(): Promise<{ authorizeUrl: string; state: string }> {
    return this.oauth.generateOAuthAuthorizeUrl();
  }

  async exchangeOAuthCode(code: string, userId: string): Promise<void> {
    return this.oauth.exchangeOAuthCode(code, userId);
  }

  async refreshOAuthToken(userId: string): Promise<void> {
    return this.oauth.refreshOAuthToken(userId);
  }

  async getValidOAuthToken(userId?: string): Promise<string | null> {
    return this.oauth.getValidOAuthToken(userId);
  }

  async getOAuthStatus(): Promise<GitHubAppOAuthStatus> {
    return this.oauth.getOAuthStatus();
  }

  // --- Setup (delegated) ---

  generateManifest(callbackUrl: string): object {
    return this.setup.generateManifest(callbackUrl);
  }

  async completeSetup(code: string, userId: string): Promise<{ appSlug: string; owner: string }> {
    return this.setup.completeSetup(code, userId);
  }

  async refreshInstallation(userId: string): Promise<{ found: boolean; installationId?: string }> {
    return this.setup.refreshInstallation(userId);
  }

  // --- Resources (delegated) ---

  async listPackages(): Promise<GitHubAppPackage[]> {
    return this.resources.listPackages();
  }

  async listPackageVersions(packageName: string): Promise<GitHubAppPackageVersion[]> {
    return this.resources.listPackageVersions(packageName);
  }

  async listRepositories(): Promise<GitHubAppRepository[]> {
    return this.resources.listRepositories();
  }

  async listActionRuns(owner: string, repo: string): Promise<GitHubAppActionsRun[]> {
    return this.resources.listActionRuns(owner, repo);
  }

  // --- Validation & Health (delegated) ---

  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    return this.validation.validate(settings);
  }

  async getHealthStatus(): Promise<ServiceHealthStatus> {
    return this.validation.getHealthStatus();
  }

  async getConfigStatus(): Promise<GitHubAppSettingResponse> {
    const agentAccess = await this.getAgentAccessStatus();
    return this.validation.getConfigStatus(agentAccess);
  }

  // --- Agent Access (stays on facade — trivial settings getters) ---

  async getAgentAccessStatus(): Promise<GitHubAgentAccessStatus> {
    const token = await this.get(SETTING_KEYS.AGENT_GITHUB_TOKEN);
    const accessLevel = await this.get(SETTING_KEYS.AGENT_GITHUB_ACCESS_LEVEL);

    return {
      isConfigured: !!token,
      accessLevel: (accessLevel as GitHubAgentAccessLevel) || null,
    };
  }

  async getAgentToken(): Promise<string | null> {
    return (await this.get(SETTING_KEYS.AGENT_GITHUB_TOKEN)) || null;
  }

  // --- Configuration Removal (stays on facade — needs circuitBreaker.reset()) ---

  async removeConfiguration(userId: string): Promise<void> {
    servicesLogger().info({ userId }, "Removing GitHub App configuration");

    const deletePromises = ALL_SETTING_KEYS.map(async (key) => {
      try {
        await this.delete(key, userId);
      } catch {
        // Ignore errors for keys that don't exist
        servicesLogger().debug(
          { key },
          "Setting key not found during removal, skipping",
        );
      }
    });

    await Promise.all(deletePromises);

    // Reset circuit breaker since configuration is gone
    this.circuitBreaker.reset();

    servicesLogger().info("GitHub App configuration removed successfully");
  }
}

// Export singleton instance
export const githubAppService = new GitHubAppService(prisma);
