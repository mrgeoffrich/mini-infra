-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_managed_networks" (
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
    "enforceMemberships" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_managed_networks" ("createdAt", "dockerId", "driver", "environmentId", "id", "name", "options", "purpose", "scope", "stackId", "status", "subnet", "updatedAt") SELECT "createdAt", "dockerId", "driver", "environmentId", "id", "name", "options", "purpose", "scope", "stackId", "status", "subnet", "updatedAt" FROM "managed_networks";
DROP TABLE "managed_networks";
ALTER TABLE "new_managed_networks" RENAME TO "managed_networks";
CREATE UNIQUE INDEX "managed_networks_name_key" ON "managed_networks"("name");
CREATE INDEX "managed_networks_environmentId_idx" ON "managed_networks"("environmentId");
CREATE INDEX "managed_networks_stackId_idx" ON "managed_networks"("stackId");
CREATE UNIQUE INDEX "managed_networks_scope_environmentId_stackId_purpose_key" ON "managed_networks"("scope", "environmentId", "stackId", "purpose");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
