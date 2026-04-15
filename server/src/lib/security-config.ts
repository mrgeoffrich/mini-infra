/**
 * In-Memory Internal Secret Store
 *
 * Holds an internal, auto-generated secret used for JWT session signing
 * and API key HMAC hashing. The secret is loaded from the database at
 * startup and is never exposed to users via any API, env var, or UI.
 */

import { appLogger } from "./logger-factory";

const logger = appLogger();

class InternalSecretStore {
  private authSecret: string | null = null;

  public setAuthSecret(secret: string): void {
    if (this.authSecret !== null) {
      logger.warn(
        "Internal auth secret is being overwritten. This should only happen during initialization.",
      );
    }
    this.authSecret = secret;
    logger.info("Internal auth secret loaded into memory");
  }

  public getAuthSecret(): string {
    if (this.authSecret === null) {
      throw new Error(
        "Internal auth secret not initialized. Ensure initializeSecuritySecrets() runs at startup.",
      );
    }
    return this.authSecret;
  }

  public isInitialized(): boolean {
    return this.authSecret !== null;
  }

  public clear(): void {
    logger.info("Clearing internal auth secret from memory");
    this.authSecret = null;
  }
}

export const internalSecrets = new InternalSecretStore();

export const getAuthSecret = () => internalSecrets.getAuthSecret();
