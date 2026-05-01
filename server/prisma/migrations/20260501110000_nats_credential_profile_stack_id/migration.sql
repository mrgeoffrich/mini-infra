-- Add a stackId FK to nats_credential_profiles. Used by the apply
-- orchestrator's diff-and-prune step to clean up role profiles when a
-- template renames or removes a role. Backfilled from the
-- `<stackId>-<roleName>` naming convention; falls back to NULL for any
-- row whose name prefix doesn't resolve to an existing stack id (those
-- rows will get repaired on their next apply via the upsert path).

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_nats_credential_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "accountId" TEXT NOT NULL,
    "stackId" TEXT,
    "publishAllow" JSONB NOT NULL,
    "subscribeAllow" JSONB NOT NULL,
    "ttlSeconds" INTEGER NOT NULL DEFAULT 3600,
    "lastAppliedAt" DATETIME,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "nats_credential_profiles_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "nats_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "nats_credential_profiles_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_nats_credential_profiles" (
    "accountId", "createdAt", "createdById", "description", "displayName",
    "id", "lastAppliedAt", "name", "publishAllow", "subscribeAllow",
    "ttlSeconds", "updatedAt", "updatedById", "stackId"
)
SELECT
    p."accountId", p."createdAt", p."createdById", p."description",
    p."displayName", p."id", p."lastAppliedAt", p."name", p."publishAllow",
    p."subscribeAllow", p."ttlSeconds", p."updatedAt", p."updatedById",
    -- Backfill: profile names follow `<stackId>-<roleName>`. Resolve only
    -- to a stack id that actually exists; otherwise leave NULL.
    (
        SELECT s."id"
        FROM "stacks" s
        WHERE p."name" = s."id" || '-' || substr(p."name", length(s."id") + 2)
        LIMIT 1
    )
FROM "nats_credential_profiles" p;

DROP TABLE "nats_credential_profiles";
ALTER TABLE "new_nats_credential_profiles" RENAME TO "nats_credential_profiles";

CREATE UNIQUE INDEX "nats_credential_profiles_name_key" ON "nats_credential_profiles"("name");
CREATE INDEX "nats_credential_profiles_accountId_idx" ON "nats_credential_profiles"("accountId");
CREATE INDEX "nats_credential_profiles_stackId_idx" ON "nats_credential_profiles"("stackId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
