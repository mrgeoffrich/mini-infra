-- CreateTable
CREATE TABLE "host_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "health" TEXT NOT NULL DEFAULT 'unknown',
    "config" JSONB,
    "startedAt" DATETIME,
    "stoppedAt" DATETIME,
    "lastError" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "host_services_serviceName_key" ON "host_services"("serviceName");

-- CreateIndex
CREATE INDEX "host_services_status_idx" ON "host_services"("status");
