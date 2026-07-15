/**
 * Pure mappers between a persisted template version (the read model,
 * `StackTemplateVersionInfo`) and the authoring/write shape (`DraftVersionInput`).
 *
 * These live in `@mini-infra/types` — not the client — because two very
 * different callers need the exact same, lossless conversion and must never
 * drift apart:
 *
 *  - the client Code-view codec and the application Configuration tab, which
 *    rebuild a draft from a version before re-saving it, and
 *  - the server template *export* endpoint, which turns a stored version into a
 *    portable document.
 *
 * The module is dependency-free (types only), preserving the package's
 * zero-runtime-dependency invariant, so both the Vite client bundle and the
 * Node server import one implementation.
 */
import type { StackServiceDefinition } from "./stacks";
import type {
  DraftVersionInput,
  StackTemplateConfigFileInfo,
  StackTemplateConfigFileInput,
  StackTemplateServiceInfo,
  StackTemplateVersionInfo,
} from "./stack-templates";

/**
 * Recursively drop keys whose value is `null`. The version read model
 * (`StackTemplateVersionInfo`) returns `null` for absent optional fields
 * (`resourceInputs`, a service's `routing`/`initCommands`/`vaultAppRoleRef`/
 * `jobPoolConfig`, `notes`, ...), but the create/draft Zod schema uses
 * `.optional()` — which rejects `null` ("expected X, received null") and only
 * accepts the value or its absence. Stripping nulls turns the read shape back
 * into a valid write shape, including nested `containerConfig` fields, without
 * enumerating every optional key by hand. The schema never uses `.nullable()`
 * for these, so a dropped null is always the right choice on this write path.
 */
export function stripNull<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNull(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = stripNull(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Rebuild a full `DraftVersionInput` from a published/draft version so that a
 * republish (via `useUpdateApplication`) is LOSSLESS — every version-level and
 * service-level field is carried through, and only the field a caller
 * explicitly overrides afterwards changes.
 *
 * Why this exists: the application Configuration tab builds its draft from
 * scratch and only sets the handful of fields the form edits, silently
 * dropping everything else on save (`resourceInputs`, `configFiles`, `vault`,
 * `nats`, `requires`, ...). Any flow that mutates a single field of an existing
 * application — e.g. the Connected Networks card changing a service's
 * `joinNetworks` — must go through here instead, or it would strip those
 * fields off the republished version.
 *
 * The result is run through `stripNull` so read-model `null`s become absent,
 * matching what the draft schema's `.optional()` fields accept.
 */
export function buildDraftFromVersion(
  version: StackTemplateVersionInfo,
): DraftVersionInput {
  const draft: DraftVersionInput = {
    parameters: version.parameters,
    defaultParameterValues: version.defaultParameterValues,
    networkTypeDefaults: version.networkTypeDefaults,
    resourceOutputs: version.resourceOutputs,
    resourceInputs: version.resourceInputs,
    // `StackNetwork[]` is assignable to `StackNetworkEntry[]`.
    networks: version.networks,
    volumes: version.volumes,
    services: (version.services ?? []).map(mapServiceInfoToDefinition),
    configFiles: version.configFiles?.map(mapConfigFileInfoToInput),
    notes: version.notes ?? undefined,
    inputs: version.inputs,
    requires: version.requires,
  };

  // vault/nats are attached AFTER the strip, deliberately. Unlike every other
  // section, their schemas use `.nullable()` — the NATS JetStream limits
  // (`maxBytes`, `maxAgeSeconds`, `maxDeliver`, …) accept an explicit null, which
  // does not mean the same thing as an absent key. Running them through stripNull
  // would quietly rewrite an author's "no limit" into "use the default".
  return {
    ...stripNull(draft),
    ...(version.vault ? { vault: version.vault } : {}),
    ...(version.nats ? { nats: version.nats } : {}),
  };
}

/**
 * Map a persisted service (`StackTemplateServiceInfo`) back into the authoring
 * shape (`StackServiceDefinition`). DB-only fields (`id`, `versionId`) are
 * dropped, EVERY authoring field is carried through (`addons`, `poolConfig`,
 * `jobPoolConfig`, and the vault/nats binding refs), and the whole result is
 * run through `stripNull` so read-model `null`s on optional-non-nullable fields
 * become absent — matching what the create/draft schema's `.optional()` fields
 * accept.
 *
 * This is the single canonical service mapper. It is write-safe standalone
 * (the `stripNull` pass means a caller can drop its output straight into a
 * `DraftVersionInput.services[]` without re-stripping), so the stack-templates
 * draft editor reuses it directly rather than hand-rolling a partial map that
 * silently drops per-service `addons`/`poolConfig`/`nats*`/`vault*` whenever any
 * service is edited. `buildDraftFromVersion` above also re-strips the whole
 * draft, but that outer pass is now redundant for services (idempotent).
 */
export function mapServiceInfoToDefinition(
  svc: StackTemplateServiceInfo,
): StackServiceDefinition {
  return stripNull({
    serviceName: svc.serviceName,
    serviceType: svc.serviceType,
    dockerImage: svc.dockerImage,
    dockerTag: svc.dockerTag,
    containerConfig: svc.containerConfig,
    initCommands: svc.initCommands ?? undefined,
    dependsOn: svc.dependsOn,
    order: svc.order,
    routing: svc.routing ?? undefined,
    adoptedContainer: svc.adoptedContainer,
    poolConfig: svc.poolConfig ?? undefined,
    jobPoolConfig: svc.jobPoolConfig,
    vaultAppRoleId: svc.vaultAppRoleId,
    vaultAppRoleRef: svc.vaultAppRoleRef,
    natsCredentialId: svc.natsCredentialId,
    natsRole: svc.natsRole,
    natsSigner: svc.natsSigner,
    addons: svc.addons ?? undefined,
  });
}

export function mapConfigFileInfoToInput(
  cf: StackTemplateConfigFileInfo,
): StackTemplateConfigFileInput {
  return {
    serviceName: cf.serviceName,
    fileName: cf.fileName,
    volumeName: cf.volumeName,
    mountPath: cf.mountPath,
    content: cf.content,
    permissions: cf.permissions ?? undefined,
    owner: cf.owner ?? undefined,
  };
}
