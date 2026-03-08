/**
 * Certificate Distributor Service
 *
 * Distributes certificates from Azure Key Vault to HAProxy containers.
 * Handles certificate deployment with zero-downtime updates using HAProxy DataPlane API.
 */

import { Logger } from "pino";
import { tlsLogger } from "../../lib/logger-factory";
import { AzureStorageCertificateStore } from "./azure-storage-certificate-store";
import { HAProxyService } from "../haproxy/haproxy-service";
import { HAProxyDataPlaneClient } from "../haproxy/haproxy-dataplane-client";
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
  method: "dataplane-api" | "runtime-api" | "volume-mount-reload";
  error?: string;
}

/**
 * Service for deploying certificates to HAProxy
 */
export class CertificateDistributor {
  private certificateStore: AzureStorageCertificateStore;
  private haproxyService: HAProxyService;
  private dockerExecutor: DockerExecutorService;
  private dataPlaneClient?: HAProxyDataPlaneClient;
  private logger: Logger;
  private certDir: string;

  constructor(
    certificateStore: AzureStorageCertificateStore,
    haproxyService: HAProxyService,
    dockerExecutor: DockerExecutorService,
    dataPlaneClient?: HAProxyDataPlaneClient
  ) {
    this.certificateStore = certificateStore;
    this.haproxyService = haproxyService;
    this.dockerExecutor = dockerExecutor;
    this.dataPlaneClient = dataPlaneClient;
    this.logger = tlsLogger();

    // Local staging directory for certificates (used as fallback when API methods fail)
    this.certDir = path.join(process.cwd(), "data", "certs");
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
    haproxyContainerId?: string,
    projectName?: string
  ): Promise<DeploymentResult> {
    this.logger.info({ certificateName, haproxyContainerId, projectName }, "Starting certificate deployment");

    try {
      // Step 1: Get certificate from Azure Storage
      this.logger.info({ certificateName }, "Retrieving certificate from Azure Storage");
      const cert = await this.certificateStore.getCertificate(certificateName);

      // Step 2: Combine certificate and private key (HAProxy format)
      const combinedPem = cert.certificate + cert.privateKey;
      // Ensure filename ends with .pem (avoid double .pem extension)
      const certFileName = certificateName.endsWith(".pem") ? certificateName : `${certificateName}.pem`;

      // Step 3: Try to initialize DataPlane client if not already available
      // When projectName is provided, always create a fresh client for that environment
      const useEnvironmentOverride = !!projectName;
      let dataPlaneClient = this.dataPlaneClient;

      if (!dataPlaneClient || useEnvironmentOverride) {
        try {
          const newClient = await this.initializeDataPlaneClient(projectName);
          if (newClient) {
            dataPlaneClient = newClient;
            // Only cache the client if we're not using an environment override
            if (!useEnvironmentOverride) {
              this.dataPlaneClient = newClient;
            }
          }
        } catch (initError) {
          this.logger.warn(
            { error: initError },
            "Failed to initialize DataPlane client, will try fallback methods"
          );
        }
      }

      // Step 4: Try DataPlane API first (preferred method - works from Docker)
      if (dataPlaneClient) {
        try {
          await this.deployCertificateViaDataPlaneAPI(certFileName, combinedPem, dataPlaneClient);

          this.logger.info({ certificateName, method: "dataplane-api" }, "Certificate deployed successfully");
          return {
            success: true,
            certificatePath: `/etc/haproxy/ssl/${certFileName}`,
            method: "dataplane-api",
          };
        } catch (dataPlaneError) {
          this.logger.warn(
            { error: dataPlaneError, certificateName },
            "DataPlane API deployment failed, falling back to Runtime API"
          );
        }
      }

      // Step 4: Write to host filesystem (required for fallback methods)
      const hostCertPath = path.join(this.certDir, certFileName);
      try {
        this.logger.info({ hostCertPath }, "Writing certificate to host filesystem");
        await fs.writeFile(hostCertPath, combinedPem, {
          mode: 0o640, // rw-r-----
        });
      } catch (fsError) {
        this.logger.warn(
          { error: fsError, certificateName },
          "Host filesystem write failed (may be running in Docker) - continuing with container methods"
        );
      }

      // Step 5: Try Runtime API (zero-downtime)
      try {
        await this.updateCertificateViaRuntimeApi(certificateName, cert.certificate, cert.privateKey, projectName);

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
        method: "dataplane-api",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Deploy certificate via HAProxy DataPlane API
   *
   * This method works whether Mini Infra runs on the host or in Docker.
   * It uses HAProxy's DataPlane API storage endpoints to upload certificates.
   *
   * @param certFileName - Certificate filename (e.g., "example.com.pem")
   * @param combinedPem - Combined certificate and private key PEM
   */
  async deployCertificateViaDataPlaneAPI(
    certFileName: string,
    combinedPem: string,
    client?: HAProxyDataPlaneClient
  ): Promise<void> {
    const dpClient = client || this.dataPlaneClient;
    if (!dpClient) {
      throw new Error("DataPlane client not available");
    }

    this.logger.info({ certFileName }, "Deploying certificate via DataPlane API");

    try {
      // IMPORTANT: Use force_reload=true so HAProxy picks up the certificate for SNI selection
      // Try update first (common case for renewals), fall back to upload if cert doesn't exist
      try {
        this.logger.debug({ certFileName }, "Attempting to update existing certificate");
        await dpClient.updateSSLCertificate(certFileName, combinedPem, true);
      } catch (updateError: any) {
        // If update fails with 404 (cert doesn't exist yet), try uploading as new
        if (updateError?.message?.includes("not found") || updateError?.message?.includes("404")) {
          this.logger.debug({ certFileName }, "Certificate does not exist, uploading as new");
          await dpClient.uploadSSLCertificate(certFileName, combinedPem, true);
        } else {
          throw updateError;
        }
      }

      this.logger.info({ certFileName }, "Certificate deployed via DataPlane API successfully");
    } catch (error) {
      this.logger.error({ error, certFileName }, "DataPlane API certificate deployment failed");
      throw error;
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
    privateKeyPem: string,
    projectName?: string
  ): Promise<void> {
    this.logger.info({ certificateName }, "Updating certificate via Runtime API");

    // Combine certificate and private key
    const combinedPem = certificatePem + privateKeyPem;

    // Certificate path inside HAProxy container (avoid double .pem extension)
    const certFile = certificateName.endsWith(".pem") ? certificateName : `${certificateName}.pem`;
    const certPath = `/etc/haproxy/ssl/${certFile}`;
    const sockPath = "/var/run/haproxy.sock";

    try {
      // Find HAProxy container using the already-initialized dockerExecutor
      const resolvedProject = projectName || this.haproxyService.getProjectName();
      const containers = await this.dockerExecutor.getProjectContainers(resolvedProject);
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
    // Pipe command via stdin to socat directly, avoiding shell interpolation
    // of PEM data and other content that may contain shell metacharacters
    const exec = await container.exec({
      Cmd: ["socat", "stdio", `unix-connect:${sockPath}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    this.logger.debug({ command }, "Executing Runtime API command via stdin");

    const stream = await exec.start({ hijack: true, stdin: true });

    return new Promise((resolve, reject) => {
      let output = "";

      stream.on("data", (chunk: Buffer) => {
        const data = chunk.toString();
        // Docker API may prefix with stream header, strip it
        const cleanData = data.replace(/^\x01\x00\x00\x00.{4}/, "");
        output += cleanData;
      });

      stream.on("end", () => {
        // Check for HAProxy Runtime API error responses
        const trimmedOutput = output.trim();
        if (
          trimmedOutput.startsWith("Can't") ||
          trimmedOutput.startsWith("No ") ||
          trimmedOutput.includes("not found") ||
          trimmedOutput.includes("error") ||
          trimmedOutput.includes("Unknown command")
        ) {
          this.logger.error({ output: trimmedOutput, command }, "HAProxy Runtime API returned an error");
          reject(new Error(`HAProxy Runtime API error: ${trimmedOutput}`));
          return;
        }
        resolve(output);
      });

      stream.on("error", (error) => {
        reject(error);
      });

      // Send command via stdin — no shell metacharacter risk
      stream.write(command + "\n");
      stream.end();
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
    // Use tee with stdin to write file content directly, avoiding shell
    // interpolation of PEM data that may contain shell metacharacters
    const exec = await container.exec({
      Cmd: ["tee", certPath],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: true });

    await new Promise<void>((resolve, reject) => {
      stream.on("data", () => {}); // drain tee's stdout echo
      stream.on("end", () => resolve());
      stream.on("error", reject);

      // Send content via stdin — no shell metacharacter risk
      stream.write(content);
      stream.end();
    });

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
   * Lazily initialize HAProxy DataPlane client by finding the running HAProxy container
   *
   * @returns Initialized DataPlane client, or null if HAProxy container not found
   */
  private async initializeDataPlaneClient(
    projectName?: string
  ): Promise<HAProxyDataPlaneClient | null> {
    try {
      const resolvedProject = projectName || this.haproxyService.getProjectName();
      const containers = await this.dockerExecutor.getProjectContainers(resolvedProject);
      const haproxyContainer = containers.find(
        (c) => c.State === "running" && c.Names?.some((name) => name.includes("haproxy"))
      );

      if (!haproxyContainer || !haproxyContainer.Id) {
        this.logger.warn("HAProxy container not found for DataPlane client initialization");
        return null;
      }

      const client = new HAProxyDataPlaneClient();
      await client.initialize(haproxyContainer.Id);
      this.logger.info("DataPlane client initialized successfully");
      return client;
    } catch (error) {
      this.logger.warn({ error }, "Failed to initialize DataPlane client");
      return null;
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
