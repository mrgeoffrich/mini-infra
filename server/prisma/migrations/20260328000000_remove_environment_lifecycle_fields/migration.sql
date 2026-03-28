-- DropIndex
DROP INDEX IF EXISTS "environments_status_idx";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_environments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "networkType" TEXT NOT NULL DEFAULT 'local',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_environments" ("id", "name", "description", "type", "networkType", "createdAt", "updatedAt") SELECT "id", "name", "description", "type", "networkType", "createdAt", "updatedAt" FROM "environments";
DROP TABLE "environments";
ALTER TABLE "new_environments" RENAME TO "environments";
CREATE UNIQUE INDEX "environments_name_key" ON "environments"("name");
CREATE INDEX "environments_type_idx" ON "environments"("type");
CREATE INDEX "environments_networkType_idx" ON "environments"("networkType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
