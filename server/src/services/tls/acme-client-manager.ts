/**
 * ACME Client Manager
 *
 * This service manages ACME protocol interactions with Let's Encrypt and other ACME providers.
 * It handles account creation, certificate requests, renewals, and revocations.
 */

import * as acme from "@mini-infra/acme";
import { Logger } from "pino";
import { tlsLogger } from "../../lib/logger-factory";
import { TlsConfigService } from "./tls-config";
import { AzureStorageCertificateStore } from "./azure-storage-certificate-store";
import { AcmeCertificateResult } from "./types";
import prisma from "../../lib/prisma";

/**
 * ACME directory URLs for different providers
 */
const ACME_DIRECTORIES = {
  letsencrypt: acme.directory.letsencrypt.production,
  "letsencrypt-staging": acme.directory.letsencrypt.staging,
  buypass: acme.directory.buypass.production,
  zerossl: acme.directory.zerossl.production,
} as const;

/**
 * DNS-01 Challenge Provider Interface
 */
export interface DnsChallenge01Provider {
  createChallenge(authz: { identifier: { value: string } }, challenge: { type: string; token: string }, keyAuthorization: string): Promise<void>;
  removeChallenge(authz: { identifier: { value: string } }, challenge: { type: string; token: string }, keyAuthorization: string): Promise<void>;
}

/**
 * Service for managing ACME client operations
 */
export class AcmeClientManager {
  private acmeClient: acme.AcmeClient | null = null;
  private certificateStore: AzureStorageCertificateStore;
  private config: TlsConfigService;
  private logger: Logger;

  constructor(config: TlsConfigService, certificateStore: AzureStorageCertificateStore) {
    this.config = config;
    this.certificateStore = certificateStore;
    this.logger = tlsLogger();
  }

  /**
   * Initialize ACME client with account from Azure Storage
   *
   * This method retrieves the ACME account key from Azure Storage and creates a client.
   * If no account key exists, it will create a new account.
   */
  async initialize(): Promise<void> {
    this.logger.info("Initializing ACME client");

    try {
      const acmeConfig = await this.config.getAcmeAccountConfig();

      // Get directory URL based on provider
      const directoryUrl = ACME_DIRECTORIES[acmeConfig.provider];
      if (!directoryUrl) {
        throw new Error(`Unknown ACME provider: ${acmeConfig.provider}`);
      }

      // Try to get existing account key from Azure Storage
      let accountKey: Buffer;
      try {
        accountKey = await this.certificateStore.getAccountKey(acmeConfig.email);
        this.logger.info({ email: acmeConfig.email }, "Using existing ACME account key");
      } catch {
        // No existing account key, create new one
        this.logger.info({ email: acmeConfig.email }, "No existing ACME account key found, will create on first use");
        // Generate a new account key
        accountKey = await acme.crypto.createPrivateKey();
        await this.certificateStore.storeAccountKey(acmeConfig.email, accountKey.toString());
      }

      // Look up any persisted ACME account URL so signed operations (e.g. revoke)
      // can run without creating a new account. Missing row is fine — auto() will
      // register on first issuance.
      const existingAccount = await prisma.acmeAccount.findFirst({
        where: { email: acmeConfig.email, provider: acmeConfig.provider, status: "ACTIVE" },
        select: { accountUrl: true },
      });

      // Create ACME client
      this.acmeClient = new acme.AcmeClient({
        directoryUrl,
        accountKey,
        accountUrl: existingAccount?.accountUrl ?? null,
      });

      this.logger.info(
        { provider: acmeConfig.provider, hasAccountUrl: Boolean(existingAccount?.accountUrl) },
        "ACME client initialized successfully"
      );
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to initialize ACME client"
      );
      throw error;
    }
  }

  /**
   * Create new ACME account
   *
   * @param email - Account email address
   * @returns ACME account details
   */
  async createAccount(email: string): Promise<unknown> {
    this.logger.info({ email }, "Creating ACME account");

    try {
      if (!this.acmeClient) {
        await this.initialize();
      }

      // Create account with terms of service agreement
      const account = await this.acmeClient!.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${email}`],
      });

      // Store account in database
      const acmeConfig = await this.config.getAcmeAccountConfig();

      // Extract account URL and TOS URL from account object
      const accountUrl = (account as { url?: string }).url || "unknown";
      const tosUrl = (account as { termsOfService?: string }).termsOfService || null;

      const containerName = await this.config.getCertificateContainerName();
      const blobName = `acme-account-${email.replace(/[^a-zA-Z0-9-]/g, "-")}.key`;

      await prisma.acmeAccount.create({
        data: {
          email,
          provider: acmeConfig.provider,
          accountUrl,
          blobContainerName: containerName,
          blobName: blobName,
          keyAlgorithm: "RSA-2048",
          status: "ACTIVE",
          termsOfServiceUrl: tosUrl,
          agreedToTermsAt: new Date(),
          createdBy: "system",
        },
      });

      this.logger.info({ email, accountUrl }, "ACME account created successfully");

      return account;
    } catch (error) {
      this.logger.error(
        { email, error: error instanceof Error ? error.message : String(error) },
        "Failed to create ACME account"
      );
      throw error;
    }
  }

  /**
   * Request certificate for domains
   *
   * @param domains - Array of domain names (first is primary domain)
   * @param challengeProvider - DNS-01 challenge provider
   * @returns Certificate, private key, and chain
   */
  async requestCertificate(
    domains: string[],
    challengeProvider: DnsChallenge01Provider
  ): Promise<AcmeCertificateResult> {
    this.logger.info({ domains }, "Requesting certificate from ACME provider");

    try {
      if (!this.acmeClient) {
        await this.initialize();
      }

      // Create CSR (Certificate Signing Request)
      const [certPrivateKey, certCsr] = await acme.crypto.createCsrPair({
        altNames: domains,
      });

      this.logger.info({ domains }, "CSR created, initiating ACME challenge");

      // Request certificate with DNS-01 challenge
      const certificate = await this.acmeClient!.auto({
        csr: certCsr,
        domains,
        termsOfServiceAgreed: true,
        challengePriority: ["dns-01"],

        challengeCreateFn: async (authz: { identifier: { value: string } }, challenge: { type: string; token: string }, keyAuthorization: string) => {
          this.logger.info(
            {
              domain: authz.identifier.value,
              challengeType: challenge.type,
            },
            "Creating DNS-01 challenge"
          );

          await challengeProvider.createChallenge(authz, challenge, keyAuthorization);
        },

        challengeRemoveFn: async (authz: { identifier: { value: string } }, challenge: { type: string; token: string }, keyAuthorization: string) => {
          this.logger.info(
            {
              domain: authz.identifier.value,
              challengeType: challenge.type,
            },
            "Removing DNS-01 challenge"
          );

          await challengeProvider.removeChallenge(authz, challenge, keyAuthorization);
        },
      });

      this.logger.info({ domains }, "Certificate issued successfully by ACME provider");

      return {
        certificate: certificate.toString(),
        privateKey: certPrivateKey.toString(),
        chain: certificate.toString(), // Let's Encrypt includes full chain in certificate
      };
    } catch (error) {
      this.logger.error(
        { domains, error: error instanceof Error ? error.message : String(error) },
        "Failed to request certificate from ACME provider"
      );
      throw error;
    }
  }

  /**
   * Renew existing certificate
   *
   * @param certificateId - Database certificate ID
   * @param challengeProvider - DNS-01 challenge provider
   * @returns New certificate, private key, and chain
   */
  async renewCertificate(
    certificateId: string,
    challengeProvider: DnsChallenge01Provider
  ): Promise<AcmeCertificateResult> {
    this.logger.info({ certificateId }, "Renewing certificate");

    try {
      // Get existing certificate from database
      const existingCert = await prisma.tlsCertificate.findUnique({
        where: { id: certificateId },
      });

      if (!existingCert) {
        throw new Error(`Certificate not found: ${certificateId}`);
      }

      // Request new certificate with same domains (ensure it's an array)
      const domains = Array.isArray(existingCert.domains) ? existingCert.domains : JSON.parse(existingCert.domains);
      return await this.requestCertificate(domains, challengeProvider);
    } catch (error) {
      this.logger.error(
        { certificateId, error: error instanceof Error ? error.message : String(error) },
        "Failed to renew certificate"
      );
      throw error;
    }
  }

  /**
   * Revoke certificate
   *
   * @param certificateId - Database certificate ID
   */
  async revokeCertificate(certificateId: string): Promise<void> {
    this.logger.info({ certificateId }, "Revoking certificate");

    try {
      if (!this.acmeClient) {
        await this.initialize();
      }

      // Get certificate from database
      const cert = await prisma.tlsCertificate.findUnique({
        where: { id: certificateId },
      });

      if (!cert) {
        throw new Error(`Certificate not found: ${certificateId}`);
      }

      if (!cert.blobName) {
        throw new Error(`Certificate blob name not found for certificate: ${certificateId}`);
      }

      // Get certificate from Azure Storage
      const { certificate } = await this.certificateStore.getCertificate(cert.blobName);

      // Revoke certificate - pass as Buffer
      await this.acmeClient!.revokeCertificate(Buffer.from(certificate));

      // Update database status
      await prisma.tlsCertificate.update({
        where: { id: certificateId },
        data: {
          status: "REVOKED",
          updatedBy: "system",
        },
      });

      this.logger.info({ certificateId }, "Certificate revoked successfully");
    } catch (error) {
      this.logger.error(
        { certificateId, error: error instanceof Error ? error.message : String(error) },
        "Failed to revoke certificate"
      );
      throw error;
    }
  }

  /**
   * Get ACME client instance (for advanced usage)
   *
   * @returns ACME client instance
   */
  async getClient(): Promise<acme.AcmeClient> {
    if (!this.acmeClient) {
      await this.initialize();
    }
    return this.acmeClient!;
  }
}
