import { servicesLogger } from "../lib/logger-factory";
import { DockerExecutorService } from "./docker-executor";
import { VolumeFileContentService } from "./volume-file-content";
import prisma from "../lib/prisma";
import { VolumeFileInfo, VolumeInspectionStatus } from "@mini-infra/types";

export interface VolumeInspectionResult {
  fileCount: number;
  totalSize: bigint;
  files: VolumeFileInfo[];
  stdout: string;
  stderr: string;
}

/**
 * VolumeInspectorService - Inspects Docker volumes by mounting them in Alpine containers
 *
 * This service creates temporary Alpine containers that mount a specified volume
 * and perform a recursive file system scan to gather information about all files.
 *
 * Key features:
 * - Mounts volumes read-only to prevent accidental modifications
 * - Captures file path, size, permissions, ownership, and modification time
 * - Stores only the latest inspection result per volume
 * - Handles large volumes with streaming output
 * - Tracks inspection status (pending, running, completed, failed)
 */
export class VolumeInspectorService {
  private dockerExecutor: DockerExecutorService;
  private static readonly INSPECTION_TIMEOUT = 10 * 60 * 1000; // 10 minutes
  private static readonly ALPINE_IMAGE = "alpine:latest";

  constructor() {
    this.dockerExecutor = new DockerExecutorService();
  }

  /**
   * Initialize the service
   */
  public async initialize(): Promise<void> {
    await this.dockerExecutor.initialize();
    servicesLogger().info("VolumeInspectorService initialized successfully");
  }

  /**
   * Start volume inspection asynchronously
   * Returns immediately after creating the inspection record
   */
  public async startInspection(volumeName: string): Promise<void> {
    const startTime = Date.now();

    try {
      // Clear any cached file contents before starting new inspection
      const fileContentService = new VolumeFileContentService();
      await fileContentService.initialize();
      await fileContentService.deleteFileContents(volumeName);

      // Create or update inspection record as 'running'
      await prisma.volumeInspection.upsert({
        where: { volumeName },
        create: {
          volumeName,
          status: "running",
          inspectedAt: new Date(),
        },
        update: {
          status: "running",
          inspectedAt: new Date(),
          completedAt: null,
          durationMs: null,
          fileCount: null,
          totalSize: null,
          files: null,
          stdout: null,
          stderr: null,
          errorMessage: null,
        },
      });

      servicesLogger().info(
        { volumeName },
        "Started volume inspection",
      );

      // Execute inspection in the background (don't await)
      this.performInspection(volumeName, startTime).catch((error) => {
        servicesLogger().error(
          {
            error: error instanceof Error ? error.message : "Unknown error",
            volumeName,
          },
          "Background volume inspection failed",
        );
      });
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to start volume inspection",
      );
      throw error;
    }
  }

  /**
   * Perform the actual volume inspection
   */
  private async performInspection(
    volumeName: string,
    startTime: number,
  ): Promise<void> {
    try {
      servicesLogger().info(
        { volumeName },
        "Executing inspection container",
      );

      // Execute Alpine container with volume mounted read-only
      const result = await this.dockerExecutor.executeContainer({
        image: VolumeInspectorService.ALPINE_IMAGE,
        env: {},
        timeout: VolumeInspectorService.INSPECTION_TIMEOUT,
        removeContainer: true,
        binds: [`${volumeName}:/volume:ro`], // Mount volume read-only at /volume
        cmd: [
          "sh",
          "-c",
          // Use find with -printf for better cross-platform compatibility
          // Format: path|size|permissions|user:group|modifiedTimestamp
          "find /volume -type f -exec stat -c '%n|%s|%a|%U:%G|%Y' {} \\;",
        ],
        labels: {
          "mini-infra.volume-inspector": "true",
          "mini-infra.volume-name": volumeName,
        },
      });

      const durationMs = Date.now() - startTime;

      // Parse the output
      const inspectionResult = this.parseInspectionOutput(
        result.stdout,
        result.stderr,
      );

      // Update database with results
      await prisma.volumeInspection.update({
        where: { volumeName },
        data: {
          status: result.exitCode === 0 ? "completed" : "failed",
          completedAt: new Date(),
          durationMs,
          fileCount: inspectionResult.fileCount,
          totalSize: inspectionResult.totalSize,
          files: JSON.stringify(inspectionResult.files),
          stdout: result.stdout,
          stderr: result.stderr,
          errorMessage: result.exitCode !== 0 ? "Container exited with non-zero code" : null,
        },
      });

      servicesLogger().info(
        {
          volumeName,
          fileCount: inspectionResult.fileCount,
          totalSize: inspectionResult.totalSize.toString(),
          durationMs,
          exitCode: result.exitCode,
        },
        "Volume inspection completed",
      );
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Update database with error
      await prisma.volumeInspection.update({
        where: { volumeName },
        data: {
          status: "failed",
          completedAt: new Date(),
          durationMs,
          errorMessage,
        },
      });

      servicesLogger().error(
        {
          error: errorMessage,
          volumeName,
          durationMs,
        },
        "Volume inspection failed",
      );

      throw error;
    }
  }

  /**
   * Parse inspection output into structured file information
   */
  private parseInspectionOutput(
    stdout: string,
    stderr: string,
  ): VolumeInspectionResult {
    const files: VolumeFileInfo[] = [];
    let totalSize = BigInt(0);

    // Split output by lines
    const lines = stdout.trim().split("\n").filter((line) => line.length > 0);

    for (const line of lines) {
      try {
        // Parse the stat output: path|size|permissions|user:group|modifiedTimestamp
        const parts = line.split("|");
        if (parts.length !== 5) {
          servicesLogger().warn(
            { line },
            "Skipping malformed inspection line",
          );
          continue;
        }

        const [path, sizeStr, permissions, owner, modifiedTimestampStr] = parts;
        const size = parseInt(sizeStr, 10);
        const modifiedTimestamp = parseInt(modifiedTimestampStr, 10);

        if (isNaN(size) || isNaN(modifiedTimestamp)) {
          servicesLogger().warn(
            { line },
            "Skipping line with invalid numbers",
          );
          continue;
        }

        // Remove /volume prefix from path (since we mount at /volume)
        const cleanPath = path.replace(/^\/volume/, "") || "/";

        files.push({
          path: cleanPath,
          size,
          permissions,
          owner,
          modifiedAt: new Date(modifiedTimestamp * 1000).toISOString(),
        });

        totalSize += BigInt(size);
      } catch (error) {
        servicesLogger().warn(
          {
            error: error instanceof Error ? error.message : "Unknown error",
            line,
          },
          "Failed to parse inspection line",
        );
        // Continue processing other lines
      }
    }

    return {
      fileCount: files.length,
      totalSize,
      files,
      stdout,
      stderr,
    };
  }

  /**
   * Get inspection status and results for a volume
   */
  public async getInspection(volumeName: string): Promise<{
    id: string;
    volumeName: string;
    status: VolumeInspectionStatus;
    inspectedAt: Date;
    completedAt: Date | null;
    durationMs: number | null;
    fileCount: number | null;
    totalSize: bigint | null;
    files: VolumeFileInfo[] | null;
    stdout: string | null;
    stderr: string | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    try {
      const inspection = await prisma.volumeInspection.findUnique({
        where: { volumeName },
      });

      if (!inspection) {
        return null;
      }

      // Parse files JSON
      let files: VolumeFileInfo[] | null = null;
      if (inspection.files) {
        try {
          files = JSON.parse(inspection.files);
        } catch (error) {
          servicesLogger().error(
            {
              error: error instanceof Error ? error.message : "Unknown error",
              volumeName,
            },
            "Failed to parse inspection files JSON",
          );
        }
      }

      return {
        ...inspection,
        status: inspection.status as VolumeInspectionStatus,
        files,
      };
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to get volume inspection",
      );
      throw error;
    }
  }

  /**
   * Check if an inspection exists for a volume
   */
  public async hasInspection(volumeName: string): Promise<boolean> {
    const inspection = await prisma.volumeInspection.findUnique({
      where: { volumeName },
      select: { id: true },
    });
    return inspection !== null;
  }

  /**
   * Delete inspection data for a volume
   */
  public async deleteInspection(volumeName: string): Promise<void> {
    try {
      await prisma.volumeInspection.delete({
        where: { volumeName },
      });

      servicesLogger().info(
        { volumeName },
        "Deleted volume inspection",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to delete volume inspection",
      );
      throw error;
    }
  }
}
