-- Service Addons framework (Phase 1, ALT-56). Adds the authoring `addons:`
-- block — a map of addon-id → addon-config — to each stack service.
--
-- Nullable: existing rows have no addons declarations yet. The render
-- pipeline in `server/src/services/stack-addons/expand-addons.ts` reads
-- this column and materialises synthetic sidecars; with the production
-- registry empty at Phase 1, every existing row continues to render
-- byte-identical to its authored form.
ALTER TABLE "stack_services" ADD COLUMN "addons" JSONB;

-- Same column on the template-side service row so user templates and
-- file-loaded built-in templates can also declare addons; resolved into
-- synthetic sidecars when the template is instantiated.
ALTER TABLE "stack_template_services" ADD COLUMN "addons" JSONB;
