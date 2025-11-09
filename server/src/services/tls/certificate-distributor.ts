/**
 * Certificate Distributor Service
 *
 * Distributes certificates from Azure Key Vault to HAProxy containers.
 * Handles certificate deployment with zero-downtime updates using HAProxy Runtime API.
 */

import { Logger } from "pino";
import { tlsLogger } from "../../lib/logger-factory";
import { AzureKeyVaultCertificateStore } from "./azure-keyvault-certificate-store";
import { HAProxyService } from "../haproxy/haproxy-service";
import { DockerExecutorService } from "../docker-executor";
import * as fs from "fs/promises";
import * as path from "path";
import Dockerode from "dockerode";

/**
 * Result of certificate deployment operation
 */
export interface DeploymentResult {
  success: boolean;
  certificatePath?: string;
  method: "runtime-api" | "volume-mount-reload";
  error?: string;
}

/**
 * Service for deploying certificates to HAProxy
 */
export class CertificateDistributor {
  private keyVaultStore: AzureKeyVaultCertificateStore;
  private haproxyService: HAProxyService;
  private dockerExecutor: DockerExecutorService;
  private logger: Logger;
  private certDir: string;

  constructor(
    keyVaultStore: AzureKeyVaultCertificateStore,
    haproxyService: HAProxyService,
    dockerExecutor: DockerExecutorService
  ) {
    this.keyVaultStore = keyVaultStore;
    this.haproxyService = haproxyService;
    this.dockerExecutor = dockerExecutor;
    this.logger = tlsLogger();

    // Certificate directory on host (mounted into HAProxy container)
    this.certDir = path.join(process.cwd(), "docker-compose", "haproxy", "certs");
  }

  /**
   * Deploy certificate to HAProxy container
   *
   * @param certificateName - Name of certificate in Key Vault
   * @param haproxyContainerId - Optional specific container ID
   * @returns Deployment result
   */
  async deployCertificate(
    certificateName: string,
    haproxyContainerId?: string
  ): Promise<DeploymentResult> {
    this.logger.info({ certificateName, haproxyContainerId }, "Starting certificate deployment");

    try {
      // Step 1: Get certificate from Key Vault
      this.logger.info({ certificateName }, "Retrieving certificate from Azure Key Vault");
      const cert = await this.keyVaultStore.getCertificate(certificateName);

      // Step 2: Combine certificate and private key (HAProxy format)
      const combinedPem = cert.certificate + cert.privateKey;

      // Step 3: Write to host filesystem (shared volume)
      const certFileName = `${certificateName}.pem`;
      const hostCertPath = path.join(this.certDir, certFileName);

      this.logger.info({ hostCertPath }, "Writing certificate to host filesystem");
      await fs.writeFile(hostCertPath, combinedPem, {
        mode: 0o640, // rw-r-----
      });

      // Step 4: Try to update via Runtime API (zero-downtime)
      try {
        await this.updateCertificateViaRuntimeApi(certificateName, cert.certificate, cert.privateKey);

        this.logger.info({ certificateName, method: "runtime-api" }, "Certificate deployed successfully");
        return {
          success: true,
          certificatePath: hostCertPath,
          method: "runtime-api",
        };
      } catch (runtimeApiError) {
        // Runtime API failed, fall back to graceful reload
        this.logger.warn(
          { error: runtimeApiError, certificateName },
          "Runtime API update failed, falling back to graceful reload"
        );

        if (haproxyContainerId) {
          await this.gracefulReload(haproxyContainerId);

          return {
            success: true,
            certificatePath: hostCertPath,
            method: "volume-mount-reload",
          };
        } else {
          throw new Error("No HAProxy container ID provided for graceful reload fallback");
        }
      }
    } catch (error) {
      this.logger.error({ error, certificateName }, "Certificate deployment failed");
      return {
        success: false,
        method: "runtime-api",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Update certificate using HAProxy Runtime API (zero-downtime)
   *
   * @param certificateName - Name of the certificate
   * @param certificatePem - PEM-encoded certificate
   * @param privateKeyPem - PEM-encoded private key
   */
  async updateCertificateViaRuntimeApi(
    certificateName: string,
    certificatePem: string,
    privateKeyPem: string
  ): Promise<void> {
    this.logger.info({ certificateName }, "Updating certificate via Runtime API");

    // Combine certificate and private key
    const combinedPem = certificatePem + privateKeyPem;

    // Certificate path inside HAProxy container
    const certPath = `/etc/ssl/certs/${certificateName}.pem`;
    const sockPath = "/var/run/haproxy.sock";

    try {
      // Find HAProxy container
      const containers = await this.haproxyService.getProjectContainers();
      const haproxyContainer = containers.find(
        (c) => c.State === "running" && c.Names?.some((name) => name.includes("haproxy"))
      );

      if (!haproxyContainer || !haproxyContainer.Id) {
        throw new Error("HAProxy container not found or not running");
      }

      const docker = this.dockerExecutor.getDockerClient();
      const container = docker.getContainer(haproxyContainer.Id);

      // HAProxy Runtime API commands for certificate update
      // 1. Start transaction
      await this.executeRuntimeCommand(
        container,
        sockPath,
        `set ssl cert ${certPath} <<\n${combinedPem}\n`
      );

      // 2. Commit transaction (activates certificate immediately)
      await this.executeRuntimeCommand(container, sockPath, `commit ssl cert ${certPath}`);

      // 3. Write to disk for persistence after restart
      await this.writeCertToContainer(container, certPath, combinedPem);

      this.logger.info({ certificateName, certPath }, "Certificate updated successfully via Runtime API");
    } catch (error) {
      this.logger.error({ error, certificateName }, "Runtime API certificate update failed");
      throw error;
    }
  }

  /**
   * Execute HAProxy Runtime API command via socat
   *
   * @param container - Docker container instance
   * @param sockPath - Path to HAProxy socket
   * @param command - Runtime API command
   * @returns Command output
   */
  private async executeRuntimeCommand(
    container: Dockerode.Container,
    sockPath: string,
    command: string
  ): Promise<string> {
    // Escape command for shell execution
    const escapedCommand = command.replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const cmd = `echo "${escapedCommand}" | socat stdio unix-connect:${sockPath}`;

    this.logger.debug({ command: cmd }, "Executing Runtime API command");

    const exec = await container.exec({
      Cmd: ["sh", "-c", cmd],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";

      stream.on("data", (chunk: Buffer) => {
        const data = chunk.toString();
        // Docker API may prefix with stream header, strip it
        const cleanData = data.replace(/^\x01\x00\x00\x00.{4}/, "");
        output += cleanData;
      });

      stream.on("end", () => {
        if (errorOutput) {
          this.logger.warn({ output, errorOutput }, "Runtime command completed with warnings");
        }
        resolve(output);
      });

      stream.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * Write certificate to container filesystem for persistence
   *
   * @param container - Docker container instance
   * @param certPath - Path inside container
   * @param content - Certificate content
   */
  private async writeCertToContainer(
    container: Dockerode.Container,
    certPath: string,
    content: string
  ): Promise<void> {
    // Escape content for shell execution
    const escapedContent = content.replace(/'/g, "'\\''");
    const cmd = `echo '${escapedContent}' > ${certPath}`;

    const exec = await container.exec({
      Cmd: ["sh", "-c", cmd],
      AttachStdout: true,
      AttachStderr: true,
    });

    await exec.start({ hijack: true, stdin: false });
    this.logger.debug({ certPath }, "Certificate written to container filesystem");
  }

  /**
   * Graceful reload fallback (for HAProxy < 2.1 or Runtime API failures)
   *
   * @param haproxyContainerId - HAProxy container ID
   */
  async gracefulReload(haproxyContainerId: string): Promise<void> {
    this.logger.info({ haproxyContainerId }, "Triggering HAProxy graceful reload");

    try {
      const docker = this.dockerExecutor.getDockerClient();
      const container = docker.getContainer(haproxyContainerId);

      // Send SIGUSR2 to trigger graceful reload (zero downtime)
      await container.kill({ signal: "SIGUSR2" });

      this.logger.info({ haproxyContainerId }, "HAProxy graceful reload triggered");
    } catch (error) {
      this.logger.error({ error, haproxyContainerId }, "Graceful reload failed");
      throw error;
    }
  }

  /**
   * Ensure certificate directory exists with correct permissions
   */
  async ensureCertificateDirectory(): Promise<void> {
    try {
      await fs.access(this.certDir);
      this.logger.debug({ certDir: this.certDir }, "Certificate directory exists");
    } catch {
      this.logger.info({ certDir: this.certDir }, "Creating certificate directory");
      await fs.mkdir(this.certDir, { recursive: true, mode: 0o750 });
    }
  }
}
