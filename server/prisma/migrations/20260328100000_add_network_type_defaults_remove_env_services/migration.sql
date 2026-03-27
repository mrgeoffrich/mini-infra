-- Add networkTypeDefaults column to stack_template_versions
ALTER TABLE "stack_template_versions" ADD COLUMN "networkTypeDefaults" TEXT NOT NULL DEFAULT '{}';

-- Populate networkTypeDefaults for existing HAProxy template versions
UPDATE "stack_template_versions"
SET "networkTypeDefaults" = '{"internet":{"http-port":8111,"https-port":8443,"stats-port":8405,"dataplane-port":5556,"expose-on-host":false}}'
WHERE "id" IN (
  SELECT stv."id" FROM "stack_template_versions" stv
  JOIN "stack_templates" st ON stv."templateId" = st."id"
  WHERE st."name" = 'haproxy' AND st."source" = 'system'
);

-- Drop environment_services table
DROP TABLE IF EXISTS "environment_services";
