import prisma, { PrismaClient } from "../lib/prisma";
import { selfBackupLogger } from "../lib/logger-factory";
import { AzureConfigService } from "./azure-config";
import { BlobServiceClient } from "@azure/storage-blob";
import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import fs from "fs/promises";
import path from "path";
import type { SelfBackup } from "@prisma/client";
import { getDatabaseFilePath } from "../lib/database-url-parser";

/**
 * SelfBackupExecutor handles the execution of Mini Infra database backups
 */
export class SelfBackupExecutor {
  private prisma: PrismaClient;
  private azureConfigService: AzureConfigService;

  // Paths
  private static readonly TEMP_DIR = path.resolve(process.cwd(), "temp");

  /**
   * Get the database file path from DATABASE_URL environment variable
   * @returns Absolute path to the SQLite database file
   */
  private static getDbPath(): string {
    return getDatabaseFilePath();
  }

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.azureConfigService = new AzureConfigService(prisma);
  }

  /**
   * Execute a complete backup operation
   * @param containerName - Azure container name
   * @param triggeredBy - 'scheduled' or 'manual'
   * @param userId - User ID if manually triggered
   * @returns SelfBackup record
   */
  async executeBackup(
    containerName: string,
    triggeredBy: 'scheduled' | 'manual',
    userId?: string
  ): Promise<SelfBackup> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
    const fileName = `mini-infra-${timestamp}.db.zip`;

    // Create initial backup record
    const backup = await this.prisma.selfBackup.create({
      data: {
        status: 'in_progress',
        azureContainerName: containerName,
        fileName: fileName,
        triggeredBy: triggeredBy,
        userId: userId || null,
      },
    });

    selfBackupLogger().info({
      backupId: backup.id,
      containerName,
      fileName,
      triggeredBy,
      userId,
    }, `Starting ${triggeredBy} backup`);

    let backupFilePath: string | null = null;
    let zipFilePath: string | null = null;

    try {
      // Ensure temp directory exists
      await fs.mkdir(SelfBackupExecutor.TEMP_DIR, { recursive: true });

      // Step 1: Create SQLite backup
      backupFilePath = path.join(SelfBackupExecutor.TEMP_DIR, `mini-infra-${timestamp}.db`);
      const dbPath = SelfBackupExecutor.getDbPath();
      await this.createSqliteBackup(dbPath, backupFilePath);

      selfBackupLogger().info({
        backupId: backup.id,
        sourcePath: dbPath,
        backupFilePath,
      }, "SQLite backup created");

      // Step 2: Compress backup file
      zipFilePath = path.join(SelfBackupExecutor.TEMP_DIR, fileName);
      await this.compressBackup(backupFilePath, zipFilePath);

      // Get file size
      const stats = await fs.stat(zipFilePath);
      const fileSize = stats.size;

      selfBackupLogger().info({
        backupId: backup.id,
        zipFilePath,
        fileSizeBytes: fileSize,
        fileSizeMB: (fileSize / (1024 * 1024)).toFixed(2),
      }, "Backup compressed");

      // Step 3: Upload to Azure
      const azureBlobUrl = await this.uploadToAzure(
        zipFilePath,
        containerName,
        fileName
      );

      selfBackupLogger().info({
        backupId: backup.id,
        azureBlobUrl,
      }, "Backup uploaded to Azure");

      // Step 4: Update backup record with success
      const durationMs = Date.now() - startTime;
      const completedBackup = await this.prisma.selfBackup.update({
        where: { id: backup.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          azureBlobUrl,
          fileSize,
          durationMs,
        },
      });

      selfBackupLogger().info({
        backupId: backup.id,
        durationMs,
        durationSeconds: (durationMs / 1000).toFixed(1),
        fileSizeMB: (fileSize / (1024 * 1024)).toFixed(2),
      }, "Backup completed successfully");

      return completedBackup;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorCode = (error as any).code || 'UNKNOWN';
      const durationMs = Date.now() - startTime;

      selfBackupLogger().error({
        backupId: backup.id,
        error: errorMessage,
        errorCode,
        durationMs,
      }, "Backup failed");

      // Update backup record with failure
      const failedBackup = await this.prisma.selfBackup.update({
        where: { id: backup.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage,
          errorCode,
          durationMs,
        },
      });

      return failedBackup;

    } finally {
      // Clean up temp files
      await this.cleanupTempFiles(backupFilePath, zipFilePath);
    }
  }

  /**
   * Create SQLite backup using better-sqlite3
   * @param sourcePath - Path to dev.db
   * @param destPath - Path to backup file
   */
  private async createSqliteBackup(sourcePath: string, destPath: string): Promise<void> {
    let sourceDb: Database.Database | null = null;

    try {
      // Open database for backup - SQLite's backup API handles concurrent access safely
      // Note: readonly mode cannot be used here as backup() may need write access for WAL checkpointing
      sourceDb = new Database(sourcePath, {
        fileMustExist: true,
      });

      // Perform backup using SQLite's backup API
      await sourceDb.backup(destPath);

      selfBackupLogger().debug({
        sourcePath,
        destPath,
      }, "SQLite backup completed via better-sqlite3");

    } catch (error) {
      selfBackupLogger().error({
        error: error instanceof Error ? error.message : 'Unknown error',
        sourcePath,
        destPath,
      }, "SQLite backup failed");
      throw error;
    } finally {
      // Always close the connection
      if (sourceDb) {
        try {
          sourceDb.close();
        } catch (closeError) {
          selfBackupLogger().warn({
            error: closeError instanceof Error ? closeError.message : 'Unknown error',
          }, "Error closing SQLite database connection");
        }
      }
    }
  }

  /**
   * Compress backup file to ZIP
   * @param backupPath - Path to .db file
   * @param zipPath - Path to output .zip file
   */
  private async compressBackup(backupPath: string, zipPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const zip = new AdmZip();

        // Add the backup file to the ZIP
        const baseName = path.basename(backupPath);
        zip.addLocalFile(backupPath);

        // Write the ZIP file
        zip.writeZip(zipPath);

        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Upload ZIP to Azure Blob Storage
   * @param zipPath - Path to ZIP file
   * @param containerName - Azure container
   * @param blobName - Blob name (filename)
   * @returns Azure blob URL
   */
  private async uploadToAzure(
    zipPath: string,
    containerName: string,
    blobName: string
  ): Promise<string> {
    // Get Azure connection string
    const connectionString = await this.azureConfigService.get("connection_string");

    if (!connectionString) {
      throw new Error("Azure connection string not configured");
    }

    // Create blob service client
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Get block blob client
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Upload file
    const fileBuffer = await fs.readFile(zipPath);
    await blockBlobClient.upload(fileBuffer, fileBuffer.length, {
      blobHTTPHeaders: {
        blobContentType: 'application/zip',
      },
      metadata: {
        'backuptype': 'self-backup',
        'createdat': new Date().toISOString(),
      },
    });

    return blockBlobClient.url;
  }

  /**
   * Clean up temporary files
   * @param filePaths - Array of file paths to delete
   */
  private async cleanupTempFiles(...filePaths: (string | null)[]): Promise<void> {
    let cleanedCount = 0;

    for (const filePath of filePaths) {
      if (!filePath) continue;

      try {
        await fs.unlink(filePath);
        cleanedCount++;
      } catch (error) {
        // Ignore errors - file might not exist
        selfBackupLogger().debug({
          filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        }, "Failed to clean up temp file");
      }
    }

    if (cleanedCount > 0) {
      selfBackupLogger().debug({
        cleanedCount,
      }, "Temp files cleaned up");
    }
  }

  /**
   * Validate backup file exists and has size > 0
   * @param filePath - Path to backup file
   */
  private async validateBackupFile(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      return stats.size > 0;
    } catch (error) {
      return false;
    }
  }
}
