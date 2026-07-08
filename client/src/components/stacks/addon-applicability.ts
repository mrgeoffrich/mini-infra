import type {
  AddonCatalogEntry,
  AddonConfigFieldDescriptor,
  StackServiceType,
} from "@mini-infra/types";

// ---------------------------------------------------------------------------
// Applicability / gating
//
// The picker gates every catalog addon two ways, and BOTH surfaces that mount
// the shared attach component (the Overview card here, the Services-tab row in
// Phase 4) must gate identically — so the logic lives here as a pure function,
// not inside the dialog's render. See §4.3 of the addon-authoring-ui plan.
// ---------------------------------------------------------------------------

/**
 * Live connectivity of a connected service, as the picker sees it. `"down"` is
 * the only state that blocks an addon — `"unknown"` (status not reported yet /
 * still loading) is treated as usable because the server re-validates the
 * prerequisite authoritatively at apply time. Mirrors how `connect-card.tsx`
 * only treats `failed`/`timeout`/`unreachable` as "down".
 */
export type ConnectivityState = "up" | "down" | "unknown";

/** A resolved link an unavailable-for-connectivity addon points the operator at. */
export interface AddonFixLink {
  to: string;
  label: string;
}

/**
 * Settings route + human label for a connected-service prerequisite. Keyed by
 * the addon manifest's `requiresConnectedService` tag (e.g. `"tailscale"`).
 * Tailscale is the only prerequisite any shipped addon declares today; the map
 * grows as new connected-service-backed addons register.
 */
const CONNECTED_SERVICE_SETTINGS: Record<string, AddonFixLink> = {
  tailscale: { to: "/connectivity-tailscale", label: "Connectivity settings" },
};

/** Human label for a connected-service tag; falls back to the raw tag. */
const CONNECTED_SERVICE_LABELS: Record<string, string> = {
  tailscale: "Tailscale",
};

export function connectedServiceLabel(tag: string): string {
  return CONNECTED_SERVICE_LABELS[tag] ?? tag;
}

export function connectedServiceFixLink(tag: string): AddonFixLink | undefined {
  return CONNECTED_SERVICE_SETTINGS[tag];
}

export interface AddonAvailability {
  available: boolean;
  /** Why the addon can't be attached (only set when `available` is false). */
  reason?: string;
  /** Where to go to fix an unavailable-for-connectivity addon, when known. */
  fix?: AddonFixLink;
}

/**
 * Whether `addon` can be attached to a service of `serviceType`, given the
 * live connectivity of every connected service (keyed by the manifest's
 * `requiresConnectedService` tag).
 *
 * Two gates, in order:
 *  1. Applicability — the addon's `appliesTo` must include the target's
 *     service type. `claude-shell` excludes `Pool`; the tailscale addons cover
 *     `Stateful`/`StatelessWeb`/`Pool`. A mismatch is a hard, unfixable "not
 *     available for X services".
 *  2. Prerequisite — if the addon declares `requiresConnectedService` and that
 *     service is `"down"`, it's unavailable with a fix link to the relevant
 *     settings page.
 */
export function getAddonAvailability(
  addon: AddonCatalogEntry,
  serviceType: StackServiceType,
  connectivity: Record<string, ConnectivityState>,
): AddonAvailability {
  if (!addon.appliesTo.includes(serviceType)) {
    return {
      available: false,
      reason: `Not available for ${serviceType} services`,
    };
  }

  const required = addon.requiresConnectedService;
  if (required && connectivity[required] === "down") {
    return {
      available: false,
      reason: `Requires ${connectedServiceLabel(required)} — not connected`,
      fix: connectedServiceFixLink(required),
    };
  }

  return { available: true };
}

// ---------------------------------------------------------------------------
// Config-form value model + mapping
//
// The per-addon config form renders one control per `configField` and holds a
// raw value keyed by the field name. `buildAddonConfig` coerces that raw state
// into the addon's config object (the value written under
// `services[].addons[addonId]`), enforcing `required` and the advisory
// `min`/`max`/`pattern` hints. The server re-validates against the real zod
// schema, so this is a UX pre-check, not the authority.
// ---------------------------------------------------------------------------

/**
 * Raw form value for a single field, shaped by the descriptor `type`:
 *  - `string` / `number` → the raw input text (numbers are parsed on submit)
 *  - `boolean`           → the checkbox state
 *  - `string[]`          → the committed chip list
 */
export type AddonFieldValue = string | boolean | string[];

export type AddonFormState = Record<string, AddonFieldValue>;

/** Blank form state for a set of fields — empty text, `false`, or `[]`. */
export function initialFormState(
  fields: AddonConfigFieldDescriptor[],
): AddonFormState {
  const state: AddonFormState = {};
  for (const field of fields) {
    switch (field.type) {
      case "boolean":
        state[field.name] = false;
        break;
      case "string[]":
        state[field.name] = [];
        break;
      default:
        state[field.name] = "";
    }
  }
  return state;
}

export type BuildAddonConfigResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

/**
 * Coerce + validate the raw form state into the addon's config object.
 *
 * Omission semantics match the hand-rolled claude-shell preset (`parseExtraTags`
 * returns `undefined` for an empty list): an optional field left blank is left
 * OUT of the config entirely rather than written as `""` / `[]`, so the addon's
 * zod schema sees it as not-provided. A required field left blank is an error.
 */
export function buildAddonConfig(
  fields: AddonConfigFieldDescriptor[],
  state: AddonFormState,
): BuildAddonConfigResult {
  const config: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const raw = state[field.name];

    switch (field.type) {
      case "boolean": {
        // A boolean is always meaningful (checked or unchecked); carry it.
        config[field.name] = Boolean(raw);
        break;
      }

      case "number": {
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text.length === 0) {
          if (field.required) errors[field.name] = `${field.label} is required`;
          break;
        }
        const value = Number(text);
        if (Number.isNaN(value)) {
          errors[field.name] = `${field.label} must be a number`;
          break;
        }
        if (field.min != null && value < field.min) {
          errors[field.name] = `${field.label} must be at least ${field.min}`;
          break;
        }
        if (field.max != null && value > field.max) {
          errors[field.name] = `${field.label} must be at most ${field.max}`;
          break;
        }
        config[field.name] = value;
        break;
      }

      case "string[]": {
        const list = Array.isArray(raw)
          ? raw.map((t) => String(t).trim()).filter((t) => t.length > 0)
          : [];
        if (list.length === 0) {
          if (field.required) errors[field.name] = `${field.label} is required`;
          break;
        }
        if (field.pattern) {
          const re = new RegExp(field.pattern);
          const bad = list.find((t) => !re.test(t));
          if (bad != null) {
            errors[field.name] = `${field.label}: "${bad}" is invalid`;
            break;
          }
        }
        config[field.name] = list;
        break;
      }

      default: {
        // string
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text.length === 0) {
          if (field.required) errors[field.name] = `${field.label} is required`;
          break;
        }
        if (field.pattern && !new RegExp(field.pattern).test(text)) {
          errors[field.name] = `${field.label} is invalid`;
          break;
        }
        config[field.name] = text;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, config };
}
