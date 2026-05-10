-- Add a stackId FK to nats_streams. Used by the apply orchestrator's
-- diff-and-prune step (`pruneOrphanRoleStreams`) to clean up app-author
-- role-derived streams when a template renames or removes a role's stream.
-- Legacy top-level `nats.streams[]` rows (system-template-only) keep
-- stackId = NULL — their lifecycle is owned by the system seeder, not a
-- stack, so they must not be swept by the per-stack prune. Backfilled
-- from the `<stackId>-<roleName>-<streamName>` naming convention.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_nats_streams" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "stackId" TEXT,
    "description" TEXT,
    "subjects" JSONB NOT NULL,
    "retention" TEXT NOT NULL DEFAULT 'limits',
    "storage" TEXT NOT NULL DEFAULT 'file',
    "maxMsgs" INTEGER,
    "maxBytes" INTEGER,
    "maxAgeSeconds" INTEGER,
    "lastAppliedAt" DATETIME,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "nats_streams_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "nats_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "nats_streams_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_nats_streams" (
    "accountId", "createdAt", "createdById", "description",
    "id", "lastAppliedAt", "maxAgeSeconds", "maxBytes", "maxMsgs",
    "name", "retention", "storage", "subjects", "updatedAt", "updatedById",
    "stackId"
)
SELECT
    s."accountId", s."createdAt", s."createdById", s."description",
    s."id", s."lastAppliedAt", s."maxAgeSeconds", s."maxBytes", s."maxMsgs",
    s."name", s."retention", s."storage", s."subjects", s."updatedAt",
    s."updatedById",
    -- Backfill: app-author stream names follow `<stackId>-<roleName>-<streamName>`.
    -- Resolve only to a stack id that actually exists; legacy system streams
    -- whose names don't match any stack id stay NULL.
    (
        SELECT st."id"
        FROM "stacks" st
        WHERE s."name" = st."id" || '-' || substr(s."name", length(st."id") + 2)
        LIMIT 1
    )
FROM "nats_streams" s;

DROP TABLE "nats_streams";
ALTER TABLE "new_nats_streams" RENAME TO "nats_streams";

CREATE UNIQUE INDEX "nats_streams_name_key" ON "nats_streams"("name");
CREATE INDEX "nats_streams_accountId_idx" ON "nats_streams"("accountId");
CREATE INDEX "nats_streams_stackId_idx" ON "nats_streams"("stackId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
