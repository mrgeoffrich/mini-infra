import { PrismaClient } from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import { getLogger } from "../lib/logger-factory";
import type {
  RegistryCredential,
  CreateRegistryCredentialRequest,
  UpdateRegistryCredentialRequest,
  RegistryTestResult,
} from "@mini-infra/types";
import { DockerExecutorService } from "./docker-executor";

export class RegistryCredentialService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // ====================
  // Registry URL Matching
  // ====================

  /**
   * Extracts registry URL from Docker image name
   * Examples:
   * - "ghcr.io/owner/repo:tag" -> "ghcr.io"
   * - "registry.hub.docker.com/library/postgres:13" -> "registry.hub.docker.com"
   * - "postgres:13" -> "registry.hub.docker.com" (Docker Hub default)
   * - "localhost:5000/image:tag" -> "localhost:5000"
   */
  private extractRegistryFromImage(imageName: string): string {
    // Remove tag if present (everything after :)
    const imageWithoutTag = imageName.split(":")[0];

    // Split by /
    const parts = imageWithoutTag.split("/");

    // If there's only one part (e.g., "postgres"), it's from Docker Hub
    if (parts.length === 1) {
      return "registry.hub.docker.com";
    }

    // If the first part contains a . or : (port), it's a registry
    // Otherwise, it's a Docker Hub username/org
    const firstPart = parts[0];
    if (firstPart.includes(".") || firstPart.includes(":")) {
      return firstPart;
    }

    // Default to Docker Hub for images like "library/postgres" or "username/image"
    return "registry.hub.docker.com";
  }

  /**
   * Get credentials for a specific Docker image
   * @param imageName - Full Docker image name (e.g., "ghcr.io/owner/repo:tag")
   * @returns Decrypted credentials or null if not found
   */
  async getCredentialsForImage(
    imageName: string,
  ): Promise<{ username: string; password: string } | null> {
    // 1. Extract registry URL from image name
    const registryUrl = this.extractRegistryFromImage(imageName);

    getLogger("docker", "registry-credential").debug(
      { imageName, registryUrl },
      "Extracting registry from image",
    );

    // 2. Find exact match in database
    const credential = await this.prisma.registryCredential.findFirst({
      where: {
        registryUrl,
        isActive: true,
      },
    });

    if (credential) {
      getLogger("docker", "registry-credential").info(
        { registryUrl, credentialId: credential.id },
        "Found credentials for registry",
      );
      return {
        username: credential.username,
        password: credential.password,
      };
    }

    // 4. Fall back to default credential if configured
    const defaultCredential = await this.getDefaultCredential();
    if (defaultCredential) {
      getLogger("docker", "registry-credential").info(
        { registryUrl, credentialId: defaultCredential.id },
        "Using default credentials for registry",
      );
      return {
        username: defaultCredential.username,
        password: defaultCredential.password,
      };
    }

    // 5. No credentials found
    getLogger("docker", "registry-credential").debug(
      { imageName, registryUrl },
      "No credentials found for image",
    );
    return null;
  }

  // ====================
  // CRUD Operations
  // ====================

  /**
   * Create a new registry credential
   */
  async createCredential(
    data: CreateRegistryCredentialRequest,
    userId: string,
  ): Promise<RegistryCredential> {
    getLogger("docker", "registry-credential").info(
      { registryUrl: data.registryUrl, userId },
      "Creating registry credential",
    );

    // If this credential should be default, unset any existing defaults
    if (data.isDefault) {
      await this.prisma.registryCredential.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    const credential = await this.prisma.registryCredential.create({
      data: {
        name: data.name,
        registryUrl: data.registryUrl,
        username: data.username,
        password: data.password,
        isDefault: data.isDefault ?? false,
        isActive: data.isActive ?? true,
        description: data.description,
        tokenExpiresAt: data.tokenExpiresAt ?? null,
        createdBy: userId,
        updatedBy: userId,
      },
    });

    getLogger("docker", "registry-credential").info(
      { credentialId: credential.id, registryUrl: credential.registryUrl },
      "Registry credential created successfully",
    );

    return credential as RegistryCredential;
  }

  /**
   * Get a single registry credential by ID
   */
  async getCredential(id: string): Promise<RegistryCredential | null> {
    const credential = await this.prisma.registryCredential.findUnique({
      where: { id },
    });

    return credential as RegistryCredential | null;
  }

  /**
   * Get all registry credentials
   */
  async getAllCredentials(
    includeInactive = false,
  ): Promise<RegistryCredential[]> {
    const credentials = await this.prisma.registryCredential.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });

    return credentials as RegistryCredential[];
  }

  /**
   * Update an existing registry credential
   */
  async updateCredential(
    id: string,
    data: UpdateRegistryCredentialRequest,
    userId: string,
  ): Promise<RegistryCredential> {
    getLogger("docker", "registry-credential").info({ credentialId: id, userId }, "Updating credential");

    // If setting as default, unset any existing defaults
    if (data.isDefault) {
      await this.prisma.registryCredential.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    // Build update data
    const updateData: Prisma.RegistryCredentialUpdateInput = {
      updatedBy: userId,
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.username !== undefined) updateData.username = data.username;
    if (data.password !== undefined) {
      updateData.password = data.password;
    }
    if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.tokenExpiresAt !== undefined) updateData.tokenExpiresAt = data.tokenExpiresAt;

    const credential = await this.prisma.registryCredential.update({
      where: { id },
      data: updateData,
    });

    getLogger("docker", "registry-credential").info(
      { credentialId: credential.id },
      "Credential updated successfully",
    );

    return credential as RegistryCredential;
  }

  /**
   * Delete a registry credential (soft delete - sets isActive to false)
   */
  async deleteCredential(id: string): Promise<void> {
    getLogger("docker", "registry-credential").info({ credentialId: id }, "Deleting credential");

    await this.prisma.registryCredential.update({
      where: { id },
      data: { isActive: false },
    });

    getLogger("docker", "registry-credential").info(
      { credentialId: id },
      "Credential deleted successfully",
    );
  }

  /**
   * Set a credential as the default registry
   */
  async setDefaultCredential(id: string): Promise<void> {
    getLogger("docker", "registry-credential").info(
      { credentialId: id },
      "Setting credential as default",
    );

    // Unset all existing defaults
    await this.prisma.registryCredential.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });

    // Set this one as default
    await this.prisma.registryCredential.update({
      where: { id },
      data: { isDefault: true },
    });

    getLogger("docker", "registry-credential").info(
      { credentialId: id },
      "Credential set as default successfully",
    );
  }

  /**
   * Get the default registry credential
   */
  async getDefaultCredential(): Promise<RegistryCredential | null> {
    const credential = await this.prisma.registryCredential.findFirst({
      where: {
        isDefault: true,
        isActive: true,
      },
    });

    return credential as RegistryCredential | null;
  }

  // ====================
  // Validation
  // ====================

  /**
   * Validate a stored credential by ID
   */
  async validateCredential(
    id: string,
    testImage?: string,
  ): Promise<RegistryTestResult> {
    const credential = await this.getCredential(id);
    if (!credential) {
      throw new Error("Credential not found");
    }

    return this.testCredential(
      credential.registryUrl,
      credential.username,
      credential.password,
      testImage,
    );
  }

  /**
   * Test a registry credential by attempting a lightweight operation
   * @param registryUrl - Registry URL
   * @param username - Registry username
   * @param password - Registry password (plain text)
   * @param testImage - Optional specific image to test (defaults to a small public image)
   */
  async testCredential(
    registryUrl: string,
    username: string,
    password: string,
    testImage?: string,
  ): Promise<RegistryTestResult> {
    getLogger("docker", "registry-credential").info({ registryUrl }, "Testing registry credentials");

    try {
      // Determine the test image to use
      const image = testImage || this.getDefaultTestImage(registryUrl);

      getLogger("docker", "registry-credential").debug(
        { registryUrl, image },
        "Using test image for registry validation",
      );

      // Initialize DockerExecutorService to test the connection
      const dockerExecutor = new DockerExecutorService();
      await dockerExecutor.initialize();

      // Attempt a fast credential test (no image pull, just manifest check)
      const dockerResult = await dockerExecutor.testDockerRegistryCredentialsFast({
        image,
        registryUsername: username,
        registryPassword: password,
      });

      getLogger("docker", "registry-credential").info(
        {
          registryUrl,
          success: dockerResult.success,
          pullTimeMs: dockerResult.details.pullTimeMs,
        },
        "Registry credential test completed",
      );

      // Map DockerRegistryTestResult to RegistryTestResult
      const result: RegistryTestResult = {
        success: dockerResult.success,
        message: dockerResult.message,
        registryUrl,
        pullTimeMs: dockerResult.details.pullTimeMs,
        error: dockerResult.details.errorCode,
      };

      // Special handling for IMAGE_NOT_FOUND on private registries
      if (
        !dockerResult.success &&
        dockerResult.details.errorCode === "IMAGE_NOT_FOUND" &&
        (registryUrl === "ghcr.io" ||
          registryUrl.includes("gitlab") ||
          registryUrl.includes("azurecr.io"))
      ) {
        result.message = "Credentials are OK";
        result.success = true; // Mark as success since auth worked
        result.error = undefined; // Clear the error code since we're treating this as success
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      getLogger("docker", "registry-credential").error(
        {
          error: errorMessage,
          registryUrl,
        },
        "Failed to test registry credentials",
      );

      return {
        success: false,
        message: `Failed to test registry credentials: ${errorMessage}`,
        registryUrl,
        error: errorMessage,
      };
    }
  }

  /**
   * Get default test image for a registry
   * Returns a small, commonly available image based on the registry
   */
  private getDefaultTestImage(registryUrl: string): string {
    // Docker Hub - use official alpine image (smallest)
    if (
      registryUrl === "registry.hub.docker.com" ||
      registryUrl === "docker.io" ||
      registryUrl.includes("hub.docker.com")
    ) {
      return "alpine:latest";
    }

    // GitHub Container Registry - use a known public linuxserver.io image
    if (registryUrl === "ghcr.io" || registryUrl.includes("github")) {
      // linuxserver.io publishes many public images to ghcr.io
      return "ghcr.io/linuxserver/baseimage-alpine:3.20";
    }

    // GitLab Container Registry
    if (registryUrl.includes("gitlab")) {
      return "registry.gitlab.com/gitlab-org/gitlab-runner/alpine:latest";
    }

    // AWS ECR Public Gallery
    if (registryUrl.includes("public.ecr.aws")) {
      return "public.ecr.aws/docker/library/alpine:latest";
    }

    // Google Container Registry / Artifact Registry
    if (registryUrl.includes("gcr.io") || registryUrl.includes("pkg.dev")) {
      return "gcr.io/google-containers/pause:latest";
    }

    // For unknown/private registries, we need the user to provide a test image
    // Return a generic format that will likely fail with a helpful error
    getLogger("docker", "registry-credential").warn(
      { registryUrl },
      "Unknown registry, user should provide testImage parameter",
    );

    return `${registryUrl}/alpine:latest`;
  }
}
