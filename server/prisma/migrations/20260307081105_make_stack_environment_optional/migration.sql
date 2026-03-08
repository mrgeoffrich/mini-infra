-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_stacks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "environmentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'undeployed',
    "lastAppliedVersion" INTEGER,
    "lastAppliedAt" DATETIME,
    "lastAppliedSnapshot" JSONB,
    "builtinVersion" INTEGER,
    "networks" JSONB NOT NULL,
    "volumes" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stacks_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_stacks" ("builtinVersion", "createdAt", "description", "environmentId", "id", "lastAppliedAt", "lastAppliedSnapshot", "lastAppliedVersion", "name", "networks", "status", "updatedAt", "version", "volumes") SELECT "builtinVersion", "createdAt", "description", "environmentId", "id", "lastAppliedAt", "lastAppliedSnapshot", "lastAppliedVersion", "name", "networks", "status", "updatedAt", "version", "volumes" FROM "stacks";
DROP TABLE "stacks";
ALTER TABLE "new_stacks" RENAME TO "stacks";
CREATE INDEX "stacks_environmentId_idx" ON "stacks"("environmentId");
CREATE INDEX "stacks_status_idx" ON "stacks"("status");
CREATE UNIQUE INDEX "stacks_name_environmentId_key" ON "stacks"("name", "environmentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
