-- Backfill Stack.templateVersionId.
--
-- The FK was added alongside the upgrade primitive, and only the upgrade path
-- ever wrote it. Every other way a stack comes into being — instantiating a
-- template, the environment manager's egress-gateway stack, the built-in stack
-- sync — set the version *number* and left the FK null. So on any existing
-- install, a stack that was installed and never upgraded has `templateVersion: 3`
-- and `templateVersionId: NULL`, which reads as "no version installed" to
-- anything that needs the exact version rather than its number (a targeted
-- upgrade; promoting a version from one environment to another).
--
-- The writers are fixed as of this release. This repairs the rows already on
-- disk by resolving (templateId, templateVersion) back to the version row.
--
-- Deliberately conservative: only fills rows that are genuinely missing it, and
-- only where the version row still exists. A stack whose template version was
-- hard-deleted stays null rather than being pointed at something plausible.
UPDATE "stacks"
SET "templateVersionId" = (
    SELECT v."id"
    FROM "stack_template_versions" v
    WHERE v."templateId" = "stacks"."templateId"
      AND v."version" = "stacks"."templateVersion"
)
WHERE "templateVersionId" IS NULL
  AND "templateId" IS NOT NULL
  AND "templateVersion" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "stack_template_versions" v
    WHERE v."templateId" = "stacks"."templateId"
      AND v."version" = "stacks"."templateVersion"
  );
