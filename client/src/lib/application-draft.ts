import type {
  DraftVersionInput,
  StackServiceDefinition,
  StackTemplateConfigFileInfo,
  StackTemplateConfigFileInput,
  StackTemplateServiceInfo,
  StackTemplateVersionInfo,
} from "@mini-infra/types";

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
function stripNull<T>(value: T): T {
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
    vault: version.vault,
    nats: version.nats,
    requires: version.requires,
  };
  return stripNull(draft);
}

/**
 * Map a persisted service (`StackTemplateServiceInfo`) back into the authoring
 * shape (`StackServiceDefinition`). DB-only fields (`id`, `versionId`) are
 * dropped; `null` on optional-non-nullable fields is normalized to `undefined`
 * so the draft matches what the create/draft schema expects.
 */
function mapServiceInfoToDefinition(
  svc: StackTemplateServiceInfo,
): StackServiceDefinition {
  return {
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
    natsCredentialRef: svc.natsCredentialRef,
    natsRole: svc.natsRole,
    natsSigner: svc.natsSigner,
    addons: svc.addons ?? undefined,
  };
}

function mapConfigFileInfoToInput(
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
