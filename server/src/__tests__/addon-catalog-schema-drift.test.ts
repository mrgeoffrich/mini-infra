/**
 * Drift / coverage guard for the addon catalog (addon-authoring-ui plan,
 * Phase 2 §4.1). Each production addon hand-authors a `configFields`
 * descriptor list on its manifest alongside its zod `configSchema`; the two
 * can silently drift. This test pins them together for every REGISTERED
 * addon: the descriptor `name`s must exactly cover the keys the zod schema
 * accepts, and each descriptor's `required` flag must match the schema's
 * optionality for that key.
 *
 * Modelled on `assertPermissionCatalogInSync()` in `lib/types/permissions.ts`
 * — same "two hand-maintained lists must stay in sync" shape, enforced by
 * introspecting the authoritative source (here, the zod schema's shape).
 *
 * Importing `productionAddonRegistry` from the `stack-addons` barrel triggers
 * the side-effect registrations, so `.list()` returns the live production set.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { productionAddonRegistry } from "../services/stack-addons";

/** Top-level keys a `z.object({...})` config schema accepts. */
function schemaKeys(schema: z.ZodTypeAny): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.keys(schema.shape);
  }
  throw new Error(
    "Addon configSchema is not a ZodObject — the drift test's introspection " +
      "needs updating for the new schema shape.",
  );
}

/**
 * A field is "not required" iff `undefined` is a valid value for it (i.e. the
 * zod schema wraps it in `.optional()`). `safeParse(undefined)` is used rather
 * than a version-specific `.isOptional()` so this survives zod upgrades.
 */
function isFieldRequired(schema: z.ZodObject<z.ZodRawShape>, key: string): boolean {
  const field = schema.shape[key];
  return !field.safeParse(undefined).success;
}

const registeredAddons = productionAddonRegistry.list();

describe("addon catalog — configFields ↔ configSchema drift", () => {
  it("registers exactly the three production addons (registry is populated)", () => {
    const ids = registeredAddons.map((a) => a.manifest.id).sort();
    expect(ids).toEqual(["claude-shell", "tailscale-ssh", "tailscale-web"]);
  });

  for (const addon of registeredAddons) {
    const id = addon.manifest.id;

    it(`${id}: configFields names exactly cover the zod schema's keys`, () => {
      const keys = schemaKeys(addon.configSchema).sort();
      const names = (addon.manifest.configFields ?? [])
        .map((f) => f.name)
        .sort();
      expect(names).toEqual(keys);
    });

    it(`${id}: each configField.required matches the schema's optionality`, () => {
      const schema = addon.configSchema;
      if (!(schema instanceof z.ZodObject)) {
        throw new Error(`${id}: configSchema is not a ZodObject`);
      }
      for (const field of addon.manifest.configFields ?? []) {
        expect(
          field.required,
          `${id}.${field.name}.required should match zod optionality`,
        ).toBe(isFieldRequired(schema, field.name));
      }
    });
  }
});
