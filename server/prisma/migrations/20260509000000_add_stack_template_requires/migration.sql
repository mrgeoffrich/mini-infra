-- Phase 1 of the split-vault-nats plan: cross-stack prerequisites on
-- stack template versions. Persisted at the version level (not the
-- template level) because prereqs can change between versions — a v3
-- template might add a `requires: vault-bootstrapped` predicate that v2
-- didn't carry, and we need to evaluate the right set against the
-- right version.
--
-- Nullable because every existing row predates the feature; the
-- evaluator treats null and [] identically (no prereqs).
ALTER TABLE "stack_template_versions" ADD COLUMN "requires" JSONB;
