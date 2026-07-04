-- CreateTable
CREATE TABLE "managed_networks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "environmentId" TEXT,
    "stackId" TEXT,
    "purpose" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'bridge',
    "options" JSONB,
    "dockerId" TEXT,
    "subnet" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "network_memberships" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "networkId" TEXT NOT NULL,
    "stackServiceId" TEXT,
    "containerName" TEXT,
    "aliases" JSONB,
    "staticIp" TEXT,
    "source" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "network_memberships_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "managed_networks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "managed_networks_name_key" ON "managed_networks"("name");

-- CreateIndex
CREATE INDEX "managed_networks_environmentId_idx" ON "managed_networks"("environmentId");

-- CreateIndex
CREATE INDEX "managed_networks_stackId_idx" ON "managed_networks"("stackId");

-- CreateIndex
CREATE UNIQUE INDEX "managed_networks_scope_environmentId_stackId_purpose_key" ON "managed_networks"("scope", "environmentId", "stackId", "purpose");

-- CreateIndex
CREATE INDEX "network_memberships_networkId_idx" ON "network_memberships"("networkId");

-- CreateIndex
CREATE UNIQUE INDEX "network_memberships_networkId_stackServiceId_containerName_key" ON "network_memberships"("networkId", "stackServiceId", "containerName");
