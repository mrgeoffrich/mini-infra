/**
 * In-Memory Security Configuration Store
 *
 * This module provides a singleton store for security-critical secrets
 * that are loaded from the database at application startup.
 *
 * These secrets are loaded once at startup and kept in memory for the
 * lifetime of the application process. They are never reloaded during
 * runtime to ensure consistency and performance.
 */

import { appLogger } from "./logger-factory";

const logger = appLogger();

interface SecuritySecrets {
  sessionSecret: string | null;
  apiKeySecret: string | null;
}

class SecurityConfigStore {
  private secrets: SecuritySecrets = {
    sessionSecret: null,
    apiKeySecret: null,
  };

  /**
   * Set the session secret
   * Should only be called once during application initialization
   */
  public setSessionSecret(secret: string): void {
    if (this.secrets.sessionSecret !== null) {
      logger.warn(
        "Session secret is being overwritten. This should only happen during initialization.",
      );
    }
    this.secrets.sessionSecret = secret;
    logger.info("Session secret loaded into memory");
  }

  /**
   * Set the API key secret
   * Should only be called once during application initialization
   */
  public setApiKeySecret(secret: string): void {
    if (this.secrets.apiKeySecret !== null) {
      logger.warn(
        "API key secret is being overwritten. This should only happen during initialization.",
      );
    }
    this.secrets.apiKeySecret = secret;
    logger.info("API key secret loaded into memory");
  }

  /**
   * Get the session secret
   * Used for signing and verifying JWT tokens
   */
  public getSessionSecret(): string {
    if (this.secrets.sessionSecret === null) {
      throw new Error(
        "Session secret not initialized. Ensure initializeSecuritySecrets() runs at startup.",
      );
    }
    return this.secrets.sessionSecret;
  }

  /**
   * Get the API key secret
   * Used for hashing API keys and encrypting sensitive configuration data
   */
  public getApiKeySecret(): string {
    if (this.secrets.apiKeySecret === null) {
      throw new Error(
        "API key secret not initialized. Ensure initializeSecuritySecrets() runs at startup.",
      );
    }
    return this.secrets.apiKeySecret;
  }

  /**
   * Check if secrets have been initialized
   * Useful for startup health checks
   */
  public isInitialized(): boolean {
    return (
      this.secrets.sessionSecret !== null && this.secrets.apiKeySecret !== null
    );
  }

  /**
   * Clear all secrets from memory
   * Should only be used during graceful shutdown or in tests
   */
  public clear(): void {
    logger.info("Clearing security secrets from memory");
    this.secrets.sessionSecret = null;
    this.secrets.apiKeySecret = null;
  }
}

// Export singleton instance
export const securityConfig = new SecurityConfigStore();

// Export getter functions for convenience
export const getSessionSecret = () => securityConfig.getSessionSecret();
export const getApiKeySecret = () => securityConfig.getApiKeySecret();
