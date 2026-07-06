-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_postgres_databases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "connectionString" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "sslMode" TEXT NOT NULL DEFAULT 'prefer',
    "environmentId" TEXT,
    "tags" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastHealthCheck" DATETIME,
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    CONSTRAINT "postgres_databases_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_postgres_databases" ("connectionString", "createdAt", "database", "healthStatus", "host", "id", "lastHealthCheck", "name", "port", "sslMode", "tags", "updatedAt", "username") SELECT "connectionString", "createdAt", "database", "healthStatus", "host", "id", "lastHealthCheck", "name", "port", "sslMode", "tags", "updatedAt", "username" FROM "postgres_databases";
DROP TABLE "postgres_databases";
ALTER TABLE "new_postgres_databases" RENAME TO "postgres_databases";
CREATE UNIQUE INDEX "postgres_databases_name_key" ON "postgres_databases"("name");
CREATE INDEX "postgres_databases_environmentId_idx" ON "postgres_databases"("environmentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
