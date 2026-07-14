import type {
  FieldDiff,
  StackTemplateServiceInfo,
  StackTemplateVersionInfo,
} from "@mini-infra/types";

/**
 * A structured, client-computed diff between two stack-template versions. Feeds
 * the template detail page's version-to-version comparison and the publish
 * dialog's "what changed" summary. Per-service field diffs reuse the same
 * `FieldDiff` shape the stack plan/diff view already renders, so the two
 * surfaces read the same visual language.
 */
export interface TemplateServiceChange {
  serviceName: string;
  fields: FieldDiff[];
}

export interface TemplateVersionDiff {
  servicesAdded: string[];
  servicesRemoved: string[];
  servicesChanged: TemplateServiceChange[];
  /** Template-level changes (parameters, networks, volumes, inputs, …). */
  meta: FieldDiff[];
  hasChanges: boolean;
}

/** Recursively key-sorted JSON so object key order can't produce false diffs. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(obj[key]);
        return acc;
      }, {});
  }
  return value ?? null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

// Identity/relational columns that aren't part of the authored definition.
const SKIP_SERVICE_KEYS = new Set(["id", "versionId", "serviceName"]);

function diffService(
  from: StackTemplateServiceInfo,
  to: StackTemplateServiceInfo,
): FieldDiff[] {
  const fromRec = from as unknown as Record<string, unknown>;
  const toRec = to as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(fromRec), ...Object.keys(toRec)]);
  const diffs: FieldDiff[] = [];
  for (const key of keys) {
    if (SKIP_SERVICE_KEYS.has(key)) continue;
    const fromVal = fromRec[key];
    const toVal = toRec[key];
    const fromStr = stableStringify(fromVal);
    const toStr = stableStringify(toVal);
    if (fromStr !== toStr) {
      diffs.push({
        field: key,
        old: fromVal === undefined ? null : fromStr,
        new: toVal === undefined ? null : toStr,
      });
    }
  }
  return diffs.sort((a, b) => a.field.localeCompare(b.field));
}

// Template-level sections diffed as a whole (label → version key).
const META_FIELDS: { key: keyof StackTemplateVersionInfo; label: string }[] = [
  { key: "parameters", label: "parameters" },
  { key: "defaultParameterValues", label: "default parameter values" },
  { key: "networks", label: "networks" },
  { key: "volumes", label: "volumes" },
  { key: "inputs", label: "inputs" },
  { key: "configFiles", label: "config files" },
  { key: "resourceOutputs", label: "resource outputs" },
  { key: "resourceInputs", label: "resource inputs" },
  { key: "vault", label: "vault" },
  { key: "nats", label: "nats" },
  { key: "requires", label: "requires" },
];

/**
 * Compute the diff from `from` (older) to `to` (newer). Both must be full
 * version payloads (with `services`) — `GET /:id/versions` already returns them.
 */
export function computeTemplateVersionDiff(
  from: StackTemplateVersionInfo | null | undefined,
  to: StackTemplateVersionInfo | null | undefined,
): TemplateVersionDiff {
  const empty: TemplateVersionDiff = {
    servicesAdded: [],
    servicesRemoved: [],
    servicesChanged: [],
    meta: [],
    hasChanges: false,
  };
  if (!from || !to) return empty;

  const fromServices = new Map((from.services ?? []).map((s) => [s.serviceName, s]));
  const toServices = new Map((to.services ?? []).map((s) => [s.serviceName, s]));

  const servicesAdded: string[] = [];
  const servicesRemoved: string[] = [];
  const servicesChanged: TemplateServiceChange[] = [];

  for (const [name, toSvc] of toServices) {
    const fromSvc = fromServices.get(name);
    if (!fromSvc) {
      servicesAdded.push(name);
      continue;
    }
    const fields = diffService(fromSvc, toSvc);
    if (fields.length > 0) servicesChanged.push({ serviceName: name, fields });
  }
  for (const name of fromServices.keys()) {
    if (!toServices.has(name)) servicesRemoved.push(name);
  }

  const meta: FieldDiff[] = [];
  for (const { key, label } of META_FIELDS) {
    const fromStr = stableStringify(from[key]);
    const toStr = stableStringify(to[key]);
    if (fromStr !== toStr) {
      meta.push({ field: label, old: fromStr, new: toStr });
    }
  }

  servicesAdded.sort();
  servicesRemoved.sort();
  servicesChanged.sort((a, b) => a.serviceName.localeCompare(b.serviceName));

  return {
    servicesAdded,
    servicesRemoved,
    servicesChanged,
    meta,
    hasChanges:
      servicesAdded.length > 0 ||
      servicesRemoved.length > 0 ||
      servicesChanged.length > 0 ||
      meta.length > 0,
  };
}
