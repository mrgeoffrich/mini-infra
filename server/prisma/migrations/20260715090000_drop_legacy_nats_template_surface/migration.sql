-- Drop the legacy low-level NATS template authoring surface.
--
-- Removed: StackTemplateVersion.natsAccounts / natsCredentials / natsStreams /
-- natsConsumers, and the per-service symbolic binding natsCredentialRef on both
-- StackTemplateService and StackService. Templates now declare NATS access only
-- through `nats.roles[]`, whose subjects are relative to the stack's
-- `nats.subjectPrefix` — which is what makes per-stack isolation enforceable
-- rather than a naming convention. Every system template had already migrated;
-- the application code that could read this shape is gone as of this release.
--
-- This does NOT touch NATS accounts/streams/consumers as *runtime* entities.
-- Those rows (NatsAccount, NatsCredentialProfile, NatsStream, NatsConsumer) are
-- untouched and still managed via /api/nats and the system bootstrap.
--
-- Data safety: a column drop is irreversible, and on an install that still had a
-- template on the old shape it would destroy that template's NATS section with
-- no trace. So anything still carrying legacy data is copied into
-- `_LegacyNatsTemplateData` first. On the expected install (nothing on the old
-- shape) that table is simply created empty and can be dropped in a later
-- release. To check an install after upgrading:
--
--     SELECT kind, rowId, data FROM _LegacyNatsTemplateData;
--
CREATE TABLE "_LegacyNatsTemplateData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "quarantinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "_LegacyNatsTemplateData" ("id", "kind", "rowId", "data")
SELECT
    lower(hex(randomblob(16))),
    'stack_template_versions',
    "id",
    json_object(
        'natsAccounts', "natsAccounts",
        'natsCredentials', "natsCredentials",
        'natsStreams', "natsStreams",
        'natsConsumers', "natsConsumers"
    )
FROM "stack_template_versions"
WHERE "natsAccounts" IS NOT NULL
   OR "natsCredentials" IS NOT NULL
   OR "natsStreams" IS NOT NULL
   OR "natsConsumers" IS NOT NULL;

INSERT INTO "_LegacyNatsTemplateData" ("id", "kind", "rowId", "data")
SELECT
    lower(hex(randomblob(16))),
    'stack_template_services',
    "id",
    json_object('natsCredentialRef', "natsCredentialRef")
FROM "stack_template_services"
WHERE "natsCredentialRef" IS NOT NULL;

INSERT INTO "_LegacyNatsTemplateData" ("id", "kind", "rowId", "data")
SELECT
    lower(hex(randomblob(16))),
    'stack_services',
    "id",
    json_object('natsCredentialRef', "natsCredentialRef")
FROM "stack_services"
WHERE "natsCredentialRef" IS NOT NULL;

ALTER TABLE "stack_template_versions" DROP COLUMN "natsAccounts";
ALTER TABLE "stack_template_versions" DROP COLUMN "natsCredentials";
ALTER TABLE "stack_template_versions" DROP COLUMN "natsStreams";
ALTER TABLE "stack_template_versions" DROP COLUMN "natsConsumers";
ALTER TABLE "stack_template_services" DROP COLUMN "natsCredentialRef";
ALTER TABLE "stack_services" DROP COLUMN "natsCredentialRef";
