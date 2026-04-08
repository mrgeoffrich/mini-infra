/**
 * In-Memory Security Configuration Store
 *
 * This module provides a singleton store for the application secret
 * that is loaded from the database at application startup.
 *
 * A single secret (APP_SECRET) is used for all cryptographic operations:
 * JWT signing, API key hashing, and credential encryption.
 */

import { appLogger } from "./logger-factory";

const logger = appLogger();

class SecurityConfigStore {
  private appSecret: string | null = null;

  /**
   * Set the application secret
   * Should only be called once during application initialization
   */
  public setAppSecret(secret: string): void {
    if (this.appSecret !== null) {
      logger.warn(
        "App secret is being overwritten. This should only happen during initialization.",
      );
    }
    this.appSecret = secret;
    logger.info("App secret loaded into memory");
  }

  /**
   * Get the application secret
   * Used for JWT signing, API key hashing, and credential encryption
   */
  public getAppSecret(): string {
    if (this.appSecret === null) {
      throw new Error(
        "App secret not initialized. Ensure initializeSecuritySecrets() runs at startup.",
      );
    }
    return this.appSecret;
  }

  // Aliases for backwards compatibility -- all return the same secret
  public getSessionSecret(): string {
    return this.getAppSecret();
  }

  public getApiKeySecret(): string {
    return this.getAppSecret();
  }

  /**
   * Check if the secret has been initialized
   */
  public isInitialized(): boolean {
    return this.appSecret !== null;
  }

  /**
   * Clear secret from memory
   * Should only be used during graceful shutdown or in tests
   */
  public clear(): void {
    logger.info("Clearing app secret from memory");
    this.appSecret = null;
  }
}

// Export singleton instance
export const securityConfig = new SecurityConfigStore();

// Export getter functions for convenience
export const getSessionSecret = () => securityConfig.getSessionSecret();
export const getApiKeySecret = () => securityConfig.getApiKeySecret();
export const getEncryptionSecret = () => securityConfig.getAppSecret();
