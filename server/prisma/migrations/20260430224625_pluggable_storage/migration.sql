/*
  Warnings:

  - You are about to drop the column `azureContainerName` on the `backup_configurations` table. All the data in the column will be lost.
  - You are about to drop the column `azurePathPrefix` on the `backup_configurations` table. All the data in the column will be lost.
  - You are about to drop the column `azureBlobUrl` on the `backup_operations` table. All the data in the column will be lost.
  - You are about to drop the column `azureBlobUrl` on the `self_backups` table. All the data in the column will be lost.
  - You are about to drop the column `azureContainerName` on the `self_backups` table. All the data in the column will be lost.
  - Added the required column `storageLocationId` to the `backup_configurations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storagePathPrefix` to the `backup_configurations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storageLocationId` to the `self_backups` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_backup_configurations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "schedule" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "storageLocationId" TEXT NOT NULL DEFAULT '',
    "storagePathPrefix" TEXT NOT NULL DEFAULT '',
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "backupFormat" TEXT NOT NULL DEFAULT 'custom',
    "compressionLevel" INTEGER NOT NULL DEFAULT 6,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastBackupAt" DATETIME,
    "nextScheduledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "backup_configurations_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "postgres_databases" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_backup_configurations" ("backupFormat", "compressionLevel", "createdAt", "databaseId", "id", "isEnabled", "lastBackupAt", "nextScheduledAt", "retentionDays", "schedule", "timezone", "updatedAt") SELECT "backupFormat", "compressionLevel", "createdAt", "databaseId", "id", "isEnabled", "lastBackupAt", "nextScheduledAt", "retentionDays", "schedule", "timezone", "updatedAt" FROM "backup_configurations";
DROP TABLE "backup_configurations";
ALTER TABLE "new_backup_configurations" RENAME TO "backup_configurations";
CREATE UNIQUE INDEX "backup_configurations_databaseId_key" ON "backup_configurations"("databaseId");
CREATE INDEX "backup_configurations_databaseId_idx" ON "backup_configurations"("databaseId");
CREATE TABLE "new_backup_operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "sizeBytes" BIGINT,
    "storageObjectUrl" TEXT,
    "storageProviderAtCreation" TEXT NOT NULL DEFAULT 'azure',
    "errorMessage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "metadata" TEXT,
    CONSTRAINT "backup_operations_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "postgres_databases" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_backup_operations" ("completedAt", "databaseId", "errorMessage", "id", "metadata", "operationType", "progress", "sizeBytes", "startedAt", "status") SELECT "completedAt", "databaseId", "errorMessage", "id", "metadata", "operationType", "progress", "sizeBytes", "startedAt", "status" FROM "backup_operations";
DROP TABLE "backup_operations";
ALTER TABLE "new_backup_operations" RENAME TO "backup_operations";
CREATE INDEX "backup_operations_databaseId_status_idx" ON "backup_operations"("databaseId", "status");
CREATE INDEX "backup_operations_startedAt_idx" ON "backup_operations"("startedAt");
CREATE TABLE "new_self_backups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "status" TEXT NOT NULL,
    "filePath" TEXT,
    "storageObjectUrl" TEXT,
    "storageLocationId" TEXT NOT NULL DEFAULT '',
    "storageProviderAtCreation" TEXT NOT NULL DEFAULT 'azure',
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "userId" TEXT,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_self_backups" ("completedAt", "createdAt", "durationMs", "errorCode", "errorMessage", "fileName", "filePath", "fileSize", "id", "startedAt", "status", "triggeredBy", "updatedAt", "userId") SELECT "completedAt", "createdAt", "durationMs", "errorCode", "errorMessage", "fileName", "filePath", "fileSize", "id", "startedAt", "status", "triggeredBy", "updatedAt", "userId" FROM "self_backups";
DROP TABLE "self_backups";
ALTER TABLE "new_self_backups" RENAME TO "self_backups";
CREATE INDEX "self_backups_status_idx" ON "self_backups"("status");
CREATE INDEX "self_backups_startedAt_idx" ON "self_backups"("startedAt");
CREATE INDEX "self_backups_storageLocationId_idx" ON "self_backups"("storageLocationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
