import Docker from "dockerode";
import { getLogger } from "../../lib/logger-factory";
import { RegistryCredentialService } from "../registry-credential";
import type { DockerRegistryTestOptions, DockerRegistryTestResult } from "./types";

/**
 * RegistryManager - Handles Docker image pulling and registry authentication
 */
export class RegistryManager {
  private docker: Docker;
  private registryCredentialService: RegistryCredentialService;

  constructor(docker: Docker, registryCredentialService: RegistryCredentialService) {
    this.docker = docker;
    this.registryCredentialService = registryCredentialService;
  }

  /**
   * Pull Docker image with authentication if credentials are provided
   * Used by backup/restore operations to ensure images are available locally
   */
  public async pullImageWithAuth(
    image: string,
    registryUsername?: string,
    registryPassword?: string,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      getLogger("docker", "registry-manager").info(
        {
          image,
          hasAuth: !!(registryUsername && registryPassword),
        },
        "Pulling Docker image with authentication",
      );

      // Prepare authentication if credentials are provided
      let authconfig: Docker.AuthConfig | Record<string, never> = {};
      if (registryUsername && registryPassword) {
        authconfig = {
          username: registryUsername,
          password: registryPassword,
        };
      }

      // Attempt to pull the image
      const stream = await this.docker.pull(image, { authconfig });

      // Wait for the pull to complete
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            reject(new Error("Docker pull timeout after 10 minutes"));
          },
          10 * 60 * 1000,
        ); // 10 minute timeout

        this.docker.modem.followProgress(stream, (err, _result) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const pullTimeMs = Date.now() - startTime;

      getLogger("docker", "registry-manager").info(
        {
          image,
          pullTimeMs,
          authenticated: !!(registryUsername && registryPassword),
        },
        "Docker image pulled successfully",
      );
    } catch (error) {
      const pullTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      getLogger("docker", "registry-manager").error(
        {
          error: errorMessage,
          image,
          pullTimeMs,
          authenticated: !!(registryUsername && registryPassword),
        },
        "Failed to pull Docker image",
      );

      // Enhance error message for better debugging
      if (
        errorMessage.includes("authentication required") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("401")
      ) {
        throw new Error(
          `Authentication required for image '${image}' - please provide valid registry credentials`,
          { cause: error },
        );
      } else if (
        errorMessage.includes("repository does not exist") ||
        errorMessage.includes("not found") ||
        errorMessage.includes("404")
      ) {
        throw new Error(`Docker image '${image}' not found in registry`, {
          cause: error,
        });
      } else if (errorMessage.includes("timeout")) {
        throw new Error(
          `Timeout pulling image '${image}' - registry may be unreachable`,
          { cause: error },
        );
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("connection refused")
      ) {
        throw new Error(
          `Network error pulling image '${image}' - cannot reach Docker registry`,
          { cause: error },
        );
      }

      throw new Error(`Failed to pull image '${image}': ${errorMessage}`, {
        cause: error,
      });
    }
  }

  /**
   * Pull Docker image with automatic credential resolution
   * Automatically finds and applies registry credentials from the database
   */
  public async pullImageWithAutoAuth(image: string): Promise<void> {
    getLogger("docker", "registry-manager").info({ image }, "Pulling image with automatic authentication");

    try {
      // Attempt to find credentials for this image's registry
      const credentials = await this.registryCredentialService.getCredentialsForImage(image);

      if (credentials) {
        getLogger("docker", "registry-manager").info(
          { image, hasCredentials: true },
          "Found registry credentials for image",
        );
        // Pull with credentials
        return this.pullImageWithAuth(
          image,
          credentials.username,
          credentials.password,
        );
      } else {
        getLogger("docker", "registry-manager").info(
          { image, hasCredentials: false },
          "No registry credentials found, attempting anonymous pull",
        );
        // No credentials - attempt anonymous pull
        return this.pullImageWithAuth(image);
      }
    } catch (error) {
      getLogger("docker", "registry-manager").error(
        { error, image },
        "Failed to pull image with auto-auth",
      );
      throw error;
    }
  }

  /**
   * Test Docker registry connection by attempting to pull an image
   */
  public async testDockerRegistryConnection(
    options: DockerRegistryTestOptions,
  ): Promise<DockerRegistryTestResult> {
    const startTime = Date.now();
    let authenticated = false;

    try {
      getLogger("docker", "registry-manager").info(
        {
          image: options.image,
          hasAuth: !!(options.registryUsername && options.registryPassword),
        },
        "Testing Docker registry connection",
      );

      // Prepare authentication if credentials are provided
      let authconfig: Docker.AuthConfig | Record<string, never> = {};
      if (options.registryUsername && options.registryPassword) {
        authenticated = true;
        authconfig = {
          username: options.registryUsername,
          password: options.registryPassword,
        };
      }

      // Attempt to pull the image
      const stream = await this.docker.pull(options.image, { authconfig });

      // Wait for the pull to complete
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            reject(new Error("Docker pull timeout after 10 minutes"));
          },
          10 * 60 * 1000,
        ); // 10 minute timeout

        this.docker.modem.followProgress(stream, (err, _result) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const pullTimeMs = Date.now() - startTime;

      getLogger("docker", "registry-manager").info(
        {
          image: options.image,
          pullTimeMs,
          authenticated,
        },
        "Docker registry connection test successful",
      );

      return {
        success: true,
        message: authenticated
          ? "Successfully connected to Docker registry with authentication and verified image access"
          : "Successfully connected to Docker registry and verified image access",
        details: {
          image: options.image,
          authenticated,
          pullTimeMs,
        },
      };
    } catch (error) {
      const pullTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      getLogger("docker", "registry-manager").error(
        {
          error: errorMessage,
          image: options.image,
          pullTimeMs,
          authenticated,
        },
        "Docker registry connection test failed",
      );

      // Determine error type for better user feedback
      let userMessage = "Failed to connect to Docker registry";
      let errorCode = "CONNECTION_FAILED";

      if (
        errorMessage.includes("authentication required") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("401")
      ) {
        userMessage =
          "Authentication required - please provide valid registry credentials";
        errorCode = "AUTHENTICATION_REQUIRED";
      } else if (
        errorMessage.includes("repository does not exist") ||
        errorMessage.includes("not found") ||
        errorMessage.includes("404")
      ) {
        userMessage = "Docker image not found in registry";
        errorCode = "IMAGE_NOT_FOUND";
      } else if (errorMessage.includes("timeout")) {
        userMessage = "Connection timeout - registry may be unreachable";
        errorCode = "TIMEOUT";
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("connection refused")
      ) {
        userMessage = "Network error - cannot reach Docker registry";
        errorCode = "NETWORK_ERROR";
      }

      return {
        success: false,
        message: `${userMessage}: ${errorMessage}`,
        details: {
          image: options.image,
          authenticated,
          pullTimeMs,
          errorCode,
        },
      };
    }
  }

  /**
   * Fast registry credential test using Docker Registry API v2
   * Only checks authentication without pulling the image
   */
  public async testDockerRegistryCredentialsFast(
    options: DockerRegistryTestOptions,
  ): Promise<DockerRegistryTestResult> {
    const startTime = Date.now();
    let authenticated = false;

    try {
      getLogger("docker", "registry-manager").info(
        {
          image: options.image,
          hasAuth: !!(options.registryUsername && options.registryPassword),
        },
        "Testing Docker registry credentials (fast check)",
      );

      authenticated = !!(options.registryUsername && options.registryPassword);

      // Parse the image name to extract registry, repository, and tag
      const imageParts = this.parseImageName(options.image);

      // Get authentication token (handles both Basic auth and OAuth2 token flow)
      const authHeader = await this.getRegistryAuthHeader(
        imageParts.registry,
        imageParts.repository,
        options.registryUsername,
        options.registryPassword,
      );

      // Build the registry API URL for manifest check
      const manifestUrl = `https://${imageParts.registry}/v2/${imageParts.repository}/manifests/${imageParts.tag}`;

      // Prepare authentication headers
      const headers: Record<string, string> = {
        Accept:
          "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
      };

      if (authHeader) {
        headers.Authorization = authHeader;
      }

      // Make HEAD request to check manifest exists and credentials work
      const response = await fetch(manifestUrl, {
        method: "HEAD",
        headers,
      });

      const pullTimeMs = Date.now() - startTime;

      if (response.ok) {
        getLogger("docker", "registry-manager").info(
          {
            image: options.image,
            pullTimeMs,
            authenticated,
            statusCode: response.status,
          },
          "Docker registry credential test successful (fast check)",
        );

        return {
          success: true,
          message: authenticated
            ? "Successfully authenticated with Docker registry and verified image access"
            : "Successfully verified image access to Docker registry",
          details: {
            image: options.image,
            authenticated,
            pullTimeMs,
          },
        };
      } else if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Authentication failed: ${response.status} ${response.statusText}`,
        );
      } else if (response.status === 404) {
        throw new Error(
          `Image not found: ${response.status} ${response.statusText}`,
        );
      } else {
        throw new Error(
          `Registry error: ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      const pullTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      getLogger("docker", "registry-manager").error(
        {
          error: errorMessage,
          image: options.image,
          pullTimeMs,
          authenticated,
        },
        "Docker registry credential test failed (fast check)",
      );

      // Determine error type for better user feedback
      let userMessage = "Failed to connect to Docker registry";
      let errorCode = "CONNECTION_FAILED";

      if (
        errorMessage.includes("Authentication failed") ||
        errorMessage.includes("401") ||
        errorMessage.includes("403")
      ) {
        userMessage = "Authentication failed - invalid credentials";
        errorCode = "AUTHENTICATION_FAILED";
      } else if (errorMessage.includes("404") || errorMessage.includes("not found")) {
        userMessage = "Image not found in registry";
        errorCode = "IMAGE_NOT_FOUND";
      } else if (errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT")) {
        userMessage = "Connection timeout - registry may be unreachable";
        errorCode = "TIMEOUT";
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("connection refused")
      ) {
        userMessage = "Network error - cannot reach Docker registry";
        errorCode = "NETWORK_ERROR";
      }

      return {
        success: false,
        message: `${userMessage}: ${errorMessage}`,
        details: {
          image: options.image,
          authenticated,
          pullTimeMs,
          errorCode,
        },
      };
    }
  }

  /**
   * Get authentication header for Docker registry
   * Handles both Basic auth and OAuth2 token flow
   */
  private async getRegistryAuthHeader(
    registry: string,
    repository: string,
    username?: string,
    password?: string,
  ): Promise<string | null> {
    if (!username || !password) {
      return null;
    }

    try {
      // First, try to get authentication challenge from registry
      const testUrl = `https://${registry}/v2/`;
      const testResponse = await fetch(testUrl, { method: "GET" });

      // Check if registry requires token authentication
      const wwwAuthenticate = testResponse.headers.get("www-authenticate");

      if (wwwAuthenticate && wwwAuthenticate.includes("Bearer")) {
        // Extract realm and service from WWW-Authenticate header
        const realmMatch = wwwAuthenticate.match(/realm="([^"]+)"/);
        const serviceMatch = wwwAuthenticate.match(/service="([^"]+)"/);

        if (realmMatch) {
          const realm = realmMatch[1];
          const service = serviceMatch ? serviceMatch[1] : registry;

          // Build token URL
          const tokenUrl = new URL(realm);
          tokenUrl.searchParams.set("service", service);
          tokenUrl.searchParams.set("scope", `repository:${repository}:pull`);

          // Request token with Basic auth
          const authString = Buffer.from(`${username}:${password}`).toString("base64");
          const tokenResponse = await fetch(tokenUrl.toString(), {
            headers: {
              Authorization: `Basic ${authString}`,
            },
          });

          if (tokenResponse.ok) {
            const tokenData = await tokenResponse.json();
            if (tokenData.token) {
              getLogger("docker", "registry-manager").debug(
                { registry, repository },
                "Successfully obtained OAuth2 token for registry",
              );
              return `Bearer ${tokenData.token}`;
            } else if (tokenData.access_token) {
              return `Bearer ${tokenData.access_token}`;
            }
          }
        }
      }

      // Fall back to Basic authentication
      getLogger("docker", "registry-manager").debug(
        { registry },
        "Using Basic authentication for registry",
      );
      const authString = Buffer.from(`${username}:${password}`).toString("base64");
      return `Basic ${authString}`;
    } catch (error) {
      getLogger("docker", "registry-manager").warn(
        {
          error: error instanceof Error ? error.message : String(error),
          registry,
        },
        "Failed to get registry auth header, falling back to Basic auth",
      );

      // Fall back to Basic auth on any error
      const authString = Buffer.from(`${username}:${password}`).toString("base64");
      return `Basic ${authString}`;
    }
  }

  /**
   * Parse Docker image name into registry, repository, and tag components
   */
  private parseImageName(imageName: string): {
    registry: string;
    repository: string;
    tag: string;
  } {
    // Default values
    let registry: string;
    let repository: string;
    let tag = "latest";

    // Split by tag first
    const tagSplit = imageName.split(":");
    if (tagSplit.length > 1) {
      tag = tagSplit[tagSplit.length - 1];
      imageName = tagSplit.slice(0, -1).join(":");
    }

    // Check if there's a registry (contains . or :)
    const parts = imageName.split("/");
    if (parts[0].includes(".") || parts[0].includes(":")) {
      registry = parts[0];
      repository = parts.slice(1).join("/");
    } else {
      // Docker Hub format
      registry = "registry-1.docker.io";
      // If only one part, it's library/image format
      if (parts.length === 1) {
        repository = `library/${parts[0]}`;
      } else {
        repository = imageName;
      }
    }

    return { registry, repository, tag };
  }
}
