-- CreateTable
CREATE TABLE "volume_inspections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "volumeName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inspectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "fileCount" INTEGER,
    "totalSize" BIGINT,
    "files" TEXT,
    "stdout" TEXT,
    "stderr" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "volume_file_contents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "volumeName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- AlterTable: Add linkedContainerId and linkedContainerName to postgres_servers
ALTER TABLE "postgres_servers" ADD COLUMN "linkedContainerId" TEXT;
ALTER TABLE "postgres_servers" ADD COLUMN "linkedContainerName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "volume_inspections_volumeName_key" ON "volume_inspections"("volumeName");

-- CreateIndex
CREATE INDEX "volume_inspections_volumeName_idx" ON "volume_inspections"("volumeName");

-- CreateIndex
CREATE INDEX "volume_inspections_status_idx" ON "volume_inspections"("status");

-- CreateIndex
CREATE INDEX "volume_inspections_inspectedAt_idx" ON "volume_inspections"("inspectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "volume_file_contents_volumeName_filePath_key" ON "volume_file_contents"("volumeName", "filePath");

-- CreateIndex
CREATE INDEX "volume_file_contents_volumeName_idx" ON "volume_file_contents"("volumeName");

-- CreateIndex
CREATE INDEX "volume_file_contents_fetchedAt_idx" ON "volume_file_contents"("fetchedAt");
