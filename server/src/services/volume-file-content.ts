import { servicesLogger } from "../lib/logger-factory";
import { DockerExecutorService } from "./docker-executor";
import prisma from "../lib/prisma";
import { VolumeFileContent } from "@mini-infra/types";

export interface FetchFileContentsResult {
  fetched: number;
  skipped: number;
  errors: string[];
}

/**
 * VolumeFileContentService - Fetches file contents from Docker volumes
 *
 * This service creates temporary Alpine containers that mount a specified volume
 * and read the contents of specified files.
 *
 * Key features:
 * - Mounts volumes read-only to prevent accidental modifications
 * - Skips binary files automatically
 * - Limits file size to 1MB per file
 * - Stores file contents in database (one record per file per volume)
 * - Uses base64 encoding for safe transport
 * - Batch fetches multiple files in a single container execution
 */
export class VolumeFileContentService {
  private dockerExecutor: DockerExecutorService;
  private static readonly FETCH_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private static readonly ALPINE_IMAGE = "alpine:latest";
  private static readonly MAX_FILE_SIZE = 1024 * 1024; // 1MB in bytes

  constructor() {
    this.dockerExecutor = new DockerExecutorService();
  }

  /**
   * Initialize the service
   */
  public async initialize(): Promise<void> {
    await this.dockerExecutor.initialize();
    servicesLogger().info("VolumeFileContentService initialized successfully");
  }

  /**
   * Fetch contents of multiple files from a volume
   * Returns a summary of fetched, skipped, and failed files
   */
  public async fetchFileContents(
    volumeName: string,
    filePaths: string[],
  ): Promise<FetchFileContentsResult> {
    const startTime = Date.now();

    if (filePaths.length === 0) {
      return { fetched: 0, skipped: 0, errors: [] };
    }

    try {
      servicesLogger().info(
        { volumeName, fileCount: filePaths.length },
        "Starting file contents fetch",
      );

      // Build shell script to fetch file contents
      const script = this.buildFetchScript(filePaths);

      // Execute Alpine container with volume mounted read-only
      const result = await this.dockerExecutor.executeContainer({
        image: VolumeFileContentService.ALPINE_IMAGE,
        env: {},
        timeout: VolumeFileContentService.FETCH_TIMEOUT,
        removeContainer: true,
        binds: [`${volumeName}:/volume:ro`], // Mount volume read-only at /volume
        cmd: ["sh", "-c", script],
        labels: {
          "mini-infra.volume-file-content": "true",
          "mini-infra.volume-name": volumeName,
        },
      });

      const durationMs = Date.now() - startTime;

      // Parse the output and store in database
      const fetchResult = await this.parseAndStoreFetchOutput(
        volumeName,
        result.stdout,
        result.stderr,
      );

      servicesLogger().info(
        {
          volumeName,
          fetched: fetchResult.fetched,
          skipped: fetchResult.skipped,
          errors: fetchResult.errors.length,
          durationMs,
        },
        "File contents fetch completed",
      );

      return fetchResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        {
          error: errorMessage,
          volumeName,
          fileCount: filePaths.length,
        },
        "File contents fetch failed",
      );

      throw error;
    }
  }

  /**
   * Build shell script to fetch file contents
   * Uses structured output format with delimiters for easy parsing
   */
  private buildFetchScript(filePaths: string[]): string {
    // Escape single quotes in file paths for shell safety
    const escapedPaths = filePaths.map((p) => p.replace(/'/g, "'\\''"));

    // Build a shell script that:
    // 1. For each file path:
    //    - Check if file exists
    //    - Check if it's a regular file
    //    - Check file size (<1MB)
    //    - Check if it's a text file (not binary)
    //    - If all checks pass, output file content with delimiters
    // 2. Use base64 encoding to safely transport content

    const script = `
set -e

# Function to process a single file
process_file() {
  local filepath="$1"
  local fullpath="/volume$filepath"

  echo "---FILE:START---"
  echo "$filepath"

  # Check if file exists
  if [ ! -e "$fullpath" ]; then
    echo "---ERROR---"
    echo "File does not exist"
    echo "---FILE:END---"
    return
  fi

  # Check if it's a regular file
  if [ ! -f "$fullpath" ]; then
    echo "---ERROR---"
    echo "Not a regular file"
    echo "---FILE:END---"
    return
  fi

  # Get file size
  local size=$(stat -c %s "$fullpath" 2>/dev/null || echo "0")
  echo "---SIZE---"
  echo "$size"

  # Check if file is too large (>1MB)
  if [ "$size" -gt ${VolumeFileContentService.MAX_FILE_SIZE} ]; then
    echo "---ERROR---"
    echo "File too large (max 1MB)"
    echo "---FILE:END---"
    return
  fi

  # Check if file is binary using 'file' command
  # We need to install 'file' command first
  if ! command -v file >/dev/null 2>&1; then
    # If file command is not available, skip binary check
    echo "---MIME---"
    echo "application/octet-stream"
  else
    local mime=$(file -b --mime-type "$fullpath" 2>/dev/null || echo "application/octet-stream")
    echo "---MIME---"
    echo "$mime"

    # Skip binary files (anything not text/*)
    if ! echo "$mime" | grep -q "^text/"; then
      # Allow some common config file types even if not detected as text
      if ! echo "$mime" | grep -qE "(json|xml|yaml|javascript|application/x-empty)"; then
        echo "---ERROR---"
        echo "Binary file (skipped)"
        echo "---FILE:END---"
        return
      fi
    fi
  fi

  # Read and base64 encode the content
  echo "---CONTENT:START---"
  base64 < "$fullpath"
  echo "---CONTENT:END---"
  echo "---FILE:END---"
}

# Process each file
${escapedPaths.map((path) => `process_file '${path}'`).join("\n")}
`;

    return script;
  }

  /**
   * Parse fetch output and store results in database
   */
  private async parseAndStoreFetchOutput(
    volumeName: string,
    stdout: string,
    stderr: string,
  ): Promise<FetchFileContentsResult> {
    const result: FetchFileContentsResult = {
      fetched: 0,
      skipped: 0,
      errors: [],
    };

    // Split output into file blocks
    const fileBlocks = stdout.split("---FILE:START---").filter((b) => b.trim());

    for (const block of fileBlocks) {
      try {
        // Extract file path (first line after FILE:START)
        const lines = block.split("\n");
        const filePath = lines[0]?.trim();

        if (!filePath) {
          servicesLogger().warn("Skipping file block with no path");
          continue;
        }

        // Check for error marker
        const errorIdx = lines.findIndex((l) => l.trim() === "---ERROR---");
        if (errorIdx !== -1) {
          const errorMsg = lines[errorIdx + 1]?.trim() || "Unknown error";
          servicesLogger().info(
            { volumeName, filePath, error: errorMsg },
            "File skipped or failed",
          );
          result.skipped++;
          result.errors.push(`${filePath}: ${errorMsg}`);
          continue;
        }

        // Extract size
        const sizeIdx = lines.findIndex((l) => l.trim() === "---SIZE---");
        const sizeStr = lines[sizeIdx + 1]?.trim();
        const size = sizeStr ? parseInt(sizeStr, 10) : 0;

        // Extract content
        const contentStartIdx = lines.findIndex(
          (l) => l.trim() === "---CONTENT:START---",
        );
        const contentEndIdx = lines.findIndex(
          (l) => l.trim() === "---CONTENT:END---",
        );

        if (contentStartIdx === -1 || contentEndIdx === -1) {
          servicesLogger().warn(
            { volumeName, filePath },
            "Missing content delimiters",
          );
          result.skipped++;
          result.errors.push(`${filePath}: Missing content`);
          continue;
        }

        // Extract base64 content (lines between START and END)
        const base64Content = lines
          .slice(contentStartIdx + 1, contentEndIdx)
          .join("\n")
          .trim();

        // Decode base64 to get actual content
        const content = Buffer.from(base64Content, "base64").toString("utf-8");

        // Store in database using upsert (one record per file per volume)
        await prisma.volumeFileContent.upsert({
          where: {
            volumeName_filePath: {
              volumeName,
              filePath,
            },
          },
          create: {
            volumeName,
            filePath,
            content,
            size,
            fetchedAt: new Date(),
          },
          update: {
            content,
            size,
            fetchedAt: new Date(),
            errorMessage: null, // Clear any previous error
          },
        });

        result.fetched++;

        servicesLogger().info(
          { volumeName, filePath, size },
          "File content stored successfully",
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        servicesLogger().error(
          { error: errorMessage, volumeName },
          "Failed to process file block",
        );
        result.errors.push(`Parse error: ${errorMessage}`);
      }
    }

    return result;
  }

  /**
   * Get file content from database
   */
  public async getFileContent(
    volumeName: string,
    filePath: string,
  ): Promise<VolumeFileContent | null> {
    try {
      const fileContent = await prisma.volumeFileContent.findUnique({
        where: {
          volumeName_filePath: {
            volumeName,
            filePath,
          },
        },
      });

      if (!fileContent) {
        return null;
      }

      return {
        id: fileContent.id,
        volumeName: fileContent.volumeName,
        filePath: fileContent.filePath,
        content: fileContent.content,
        size: fileContent.size,
        fetchedAt: fileContent.fetchedAt.toISOString(),
        errorMessage: fileContent.errorMessage,
        createdAt: fileContent.createdAt.toISOString(),
        updatedAt: fileContent.updatedAt.toISOString(),
      };
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
          filePath,
        },
        "Failed to get file content",
      );
      throw error;
    }
  }

  /**
   * Check if file content exists for a specific file
   */
  public async hasFileContent(
    volumeName: string,
    filePath: string,
  ): Promise<boolean> {
    const fileContent = await prisma.volumeFileContent.findUnique({
      where: {
        volumeName_filePath: {
          volumeName,
          filePath,
        },
      },
      select: { id: true },
    });
    return fileContent !== null;
  }

  /**
   * Get all file contents for a volume
   */
  public async getAllFileContents(
    volumeName: string,
  ): Promise<VolumeFileContent[]> {
    try {
      const fileContents = await prisma.volumeFileContent.findMany({
        where: { volumeName },
        orderBy: { filePath: "asc" },
      });

      return fileContents.map((fc) => ({
        id: fc.id,
        volumeName: fc.volumeName,
        filePath: fc.filePath,
        content: fc.content,
        size: fc.size,
        fetchedAt: fc.fetchedAt.toISOString(),
        errorMessage: fc.errorMessage,
        createdAt: fc.createdAt.toISOString(),
        updatedAt: fc.updatedAt.toISOString(),
      }));
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to get all file contents",
      );
      throw error;
    }
  }

  /**
   * Delete all file contents for a volume
   * Called when starting a new volume inspection
   */
  public async deleteFileContents(volumeName: string): Promise<void> {
    try {
      const result = await prisma.volumeFileContent.deleteMany({
        where: { volumeName },
      });

      servicesLogger().info(
        { volumeName, deletedCount: result.count },
        "Deleted file contents for volume",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
        },
        "Failed to delete file contents",
      );
      throw error;
    }
  }

  /**
   * Delete a specific file content
   */
  public async deleteFileContent(
    volumeName: string,
    filePath: string,
  ): Promise<void> {
    try {
      await prisma.volumeFileContent.delete({
        where: {
          volumeName_filePath: {
            volumeName,
            filePath,
          },
        },
      });

      servicesLogger().info(
        { volumeName, filePath },
        "Deleted file content",
      );
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          volumeName,
          filePath,
        },
        "Failed to delete file content",
      );
      throw error;
    }
  }
}
