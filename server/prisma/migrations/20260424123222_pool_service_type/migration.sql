-- CreateTable
CREATE TABLE "pool_instances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "containerId" TEXT,
    "status" TEXT NOT NULL,
    "idleTimeoutMinutes" INTEGER NOT NULL,
    "lastActive" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" DATETIME,
    "errorMessage" TEXT,
    CONSTRAINT "pool_instances_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_stack_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "dockerImage" TEXT NOT NULL,
    "dockerTag" TEXT NOT NULL,
    "containerConfig" JSONB NOT NULL,
    "configFiles" JSONB,
    "initCommands" JSONB,
    "dependsOn" JSONB NOT NULL,
    "order" INTEGER NOT NULL,
    "routing" JSONB,
    "adoptedContainer" JSONB,
    "poolConfig" JSONB,
    "poolManagementTokenHash" TEXT,
    "vaultAppRoleId" TEXT,
    "lastAppliedVaultAppRoleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stack_services_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stack_services_vaultAppRoleId_fkey" FOREIGN KEY ("vaultAppRoleId") REFERENCES "vault_app_roles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_stack_services" ("adoptedContainer", "configFiles", "containerConfig", "createdAt", "dependsOn", "dockerImage", "dockerTag", "id", "initCommands", "order", "routing", "serviceName", "serviceType", "stackId", "updatedAt") SELECT "adoptedContainer", "configFiles", "containerConfig", "createdAt", "dependsOn", "dockerImage", "dockerTag", "id", "initCommands", "order", "routing", "serviceName", "serviceType", "stackId", "updatedAt" FROM "stack_services";
DROP TABLE "stack_services";
ALTER TABLE "new_stack_services" RENAME TO "stack_services";
CREATE INDEX "stack_services_stackId_idx" ON "stack_services"("stackId");
CREATE INDEX "stack_services_vaultAppRoleId_idx" ON "stack_services"("vaultAppRoleId");
CREATE UNIQUE INDEX "stack_services_stackId_serviceName_key" ON "stack_services"("stackId", "serviceName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "pool_instances_stackId_idx" ON "pool_instances"("stackId");

-- CreateIndex
CREATE INDEX "pool_instances_stackId_serviceName_idx" ON "pool_instances"("stackId", "serviceName");

-- CreateIndex
CREATE INDEX "pool_instances_status_idx" ON "pool_instances"("status");

-- CreateIndex
CREATE INDEX "pool_instances_status_lastActive_idx" ON "pool_instances"("status", "lastActive");

-- Partial unique index: at most one active (starting/running) instance per
-- (stackId, serviceName, instanceId). Prisma does not support filtered
-- indexes in its schema DSL, so this is hand-written. Application code must
-- also enforce the check inside the ensure-instance handler because the DB
-- constraint is only a defence-in-depth backstop.
CREATE UNIQUE INDEX "pool_instance_active_unique"
ON "pool_instances" ("stackId", "serviceName", "instanceId")
WHERE "status" IN ('starting', 'running');
