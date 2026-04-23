import yaml from "js-yaml";
import type {
  DraftVersionInput,
  StackTemplateVersionInfo,
  StackServiceDefinition,
  StackTemplateConfigFileInput,
} from "@mini-infra/types";

/**
 * The YAML view of a template version. Field order matches how the graphical
 * editor presents sections, so a round-trip feels stable. Empty collections
 * are omitted on output (via dropEmpty) and tolerated on input.
 */

function dropEmpty<T>(value: T): T | undefined {
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : value;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length === 0 ? undefined : value;
  }
  return value;
}

function versionInfoToDraftInput(v: StackTemplateVersionInfo): DraftVersionInput {
  const services: StackServiceDefinition[] = (v.services ?? []).map((s) => ({
    serviceName: s.serviceName,
    serviceType: s.serviceType,
    dockerImage: s.dockerImage,
    dockerTag: s.dockerTag,
    containerConfig: s.containerConfig,
    initCommands: s.initCommands ?? undefined,
    dependsOn: s.dependsOn,
    order: s.order,
    routing: s.routing ?? undefined,
    adoptedContainer: s.adoptedContainer ?? undefined,
  }));

  const configFiles: StackTemplateConfigFileInput[] | undefined =
    v.configFiles && v.configFiles.length > 0
      ? v.configFiles.map((cf) => ({
          serviceName: cf.serviceName,
          fileName: cf.fileName,
          volumeName: cf.volumeName,
          mountPath: cf.mountPath,
          content: cf.content,
          permissions: cf.permissions ?? undefined,
          owner: cf.owner ?? undefined,
        }))
      : undefined;

  return {
    parameters: dropEmpty(v.parameters ?? []),
    defaultParameterValues: dropEmpty(v.defaultParameterValues ?? {}),
    networkTypeDefaults: dropEmpty(v.networkTypeDefaults ?? {}),
    resourceOutputs: dropEmpty(v.resourceOutputs ?? []),
    resourceInputs: dropEmpty(v.resourceInputs ?? []),
    networks: v.networks,
    volumes: v.volumes,
    services,
    configFiles,
    notes: v.notes ?? undefined,
  };
}

/**
 * Render a template version as YAML. Accepts the wire `StackTemplateVersionInfo`
 * straight from the API or an already-prepared `DraftVersionInput`.
 */
export function serializeVersionToYaml(
  input: StackTemplateVersionInfo | DraftVersionInput,
): string {
  const draft: DraftVersionInput =
    "id" in input ? versionInfoToDraftInput(input) : input;

  // Present keys in a meaningful order.
  const ordered: Record<string, unknown> = {};
  if (draft.notes) ordered.notes = draft.notes;
  if (draft.parameters) ordered.parameters = draft.parameters;
  if (draft.defaultParameterValues)
    ordered.defaultParameterValues = draft.defaultParameterValues;
  if (draft.networkTypeDefaults)
    ordered.networkTypeDefaults = draft.networkTypeDefaults;
  if (draft.resourceOutputs) ordered.resourceOutputs = draft.resourceOutputs;
  if (draft.resourceInputs) ordered.resourceInputs = draft.resourceInputs;
  ordered.networks = draft.networks ?? [];
  ordered.volumes = draft.volumes ?? [];
  ordered.services = draft.services ?? [];
  if (draft.configFiles) ordered.configFiles = draft.configFiles;

  return yaml.dump(ordered, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    // `content` inside configFiles is often multi-line; use block scalar.
    styles: { "!!null": "empty" },
  });
}

export type ParseResult =
  | { ok: true; value: DraftVersionInput }
  | { ok: false; error: string; line?: number };

/**
 * Parse YAML into a DraftVersionInput. Applies light structural validation —
 * the server does the heavy lifting via Zod on submit.
 */
export function parseYamlToDraft(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    if (err instanceof yaml.YAMLException) {
      return {
        ok: false,
        error: err.reason ?? err.message,
        line: err.mark?.line !== undefined ? err.mark.line + 1 : undefined,
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid YAML",
    };
  }

  if (parsed === null || parsed === undefined) {
    return { ok: false, error: "YAML document is empty" };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Top-level YAML must be a mapping" };
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.networks)) {
    return { ok: false, error: "`networks` must be an array" };
  }
  if (!Array.isArray(obj.volumes)) {
    return { ok: false, error: "`volumes` must be an array" };
  }
  if (!Array.isArray(obj.services)) {
    return { ok: false, error: "`services` must be an array" };
  }

  return { ok: true, value: obj as unknown as DraftVersionInput };
}
