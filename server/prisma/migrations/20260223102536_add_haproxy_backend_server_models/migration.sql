-- CreateTable
CREATE TABLE "haproxy_backends" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'http',
    "balanceAlgorithm" TEXT NOT NULL DEFAULT 'roundrobin',
    "checkTimeout" INTEGER,
    "connectTimeout" INTEGER,
    "serverTimeout" INTEGER,
    "sourceType" TEXT NOT NULL,
    "deploymentConfigId" TEXT,
    "manualFrontendId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "haproxy_backends_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "haproxy_servers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "backendId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "check" TEXT NOT NULL DEFAULT 'enabled',
    "checkPath" TEXT,
    "inter" INTEGER,
    "rise" INTEGER,
    "fall" INTEGER,
    "weight" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maintenance" BOOLEAN NOT NULL DEFAULT false,
    "containerId" TEXT,
    "containerName" TEXT,
    "deploymentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "haproxy_servers_backendId_fkey" FOREIGN KEY ("backendId") REFERENCES "haproxy_backends" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "haproxy_backends_environmentId_idx" ON "haproxy_backends"("environmentId");

-- CreateIndex
CREATE INDEX "haproxy_backends_status_idx" ON "haproxy_backends"("status");

-- CreateIndex
CREATE INDEX "haproxy_backends_sourceType_idx" ON "haproxy_backends"("sourceType");

-- CreateIndex
CREATE INDEX "haproxy_backends_deploymentConfigId_idx" ON "haproxy_backends"("deploymentConfigId");

-- CreateIndex
CREATE UNIQUE INDEX "haproxy_backends_name_environmentId_key" ON "haproxy_backends"("name", "environmentId");

-- CreateIndex
CREATE INDEX "haproxy_servers_backendId_idx" ON "haproxy_servers"("backendId");

-- CreateIndex
CREATE INDEX "haproxy_servers_status_idx" ON "haproxy_servers"("status");

-- CreateIndex
CREATE INDEX "haproxy_servers_containerId_idx" ON "haproxy_servers"("containerId");

-- CreateIndex
CREATE UNIQUE INDEX "haproxy_servers_name_backendId_key" ON "haproxy_servers"("name", "backendId");
