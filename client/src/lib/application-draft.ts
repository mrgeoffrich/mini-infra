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
    natsCredentialRef: svc.natsCredentialRef,
    natsRole: svc.natsRole,
    natsSigner: svc.natsSigner,
    addons: svc.addons ?? undefined,
  });
}

/**
 * Merge a Code-view (YAML) edit over the current draft so that saving from the
 * lossy YAML editor never silently strips sections the codec can't represent.
 *
 * The YAML codec (`yaml-codec.ts`) only models a subset of the template: it
 * drops the top-level `inputs`/`vault`/`nats`/`requires` sections entirely and
 * every per-service binding field (`addons`, `poolConfig`, `jobPoolConfig`,
 * `natsRole`/`natsSigner`, vault/nats credential refs). Sending the parsed YAML
 * as a full draft replace would wipe all of those.
 *
 * This merges the parsed YAML result (which fully owns the fields it DOES
 * represent, including deletions) over `base` (the lossless
 * `buildDraftFromVersion` mapping of the current version):
 *   - top-level `inputs`/`vault`/`nats`/`requires` carry through from `base`;
 *   - per-service, matched by `serviceName`, the unrepresented binding fields
 *     are re-attached from the matching base service (mirroring the
 *     `{...service, ...definition}` preservation in service-edit-drawer.tsx).
 *
 * A service deleted in the YAML is deleted (it simply won't appear in
 * `parsed.services`); a renamed service has no base match and loses its
 * preserved fields — acceptable, and the same limitation the graphical editor
 * has.
 */
export function mergeCodeViewDraft(
  base: DraftVersionInput,
  parsed: DraftVersionInput,
): DraftVersionInput {
  const baseServicesByName = new Map(
    (base.services ?? []).map((s) => [s.serviceName, s]),
  );

  const services: StackServiceDefinition[] = (parsed.services ?? []).map((svc) => {
    const baseSvc = baseServicesByName.get(svc.serviceName);
    if (!baseSvc) return svc; // new or renamed service — nothing to preserve

    // Re-attach only the fields the codec can't represent. `svc` (the YAML
    // edit) is the base layer so it fully controls every represented field,
    // including removals; the unrepresented fields are layered back on top.
    return {
      ...svc,
      ...(baseSvc.addons !== undefined ? { addons: baseSvc.addons } : {}),
      ...(baseSvc.poolConfig !== undefined ? { poolConfig: baseSvc.poolConfig } : {}),
      ...(baseSvc.jobPoolConfig !== undefined ? { jobPoolConfig: baseSvc.jobPoolConfig } : {}),
      ...(baseSvc.natsRole !== undefined ? { natsRole: baseSvc.natsRole } : {}),
      ...(baseSvc.natsSigner !== undefined ? { natsSigner: baseSvc.natsSigner } : {}),
      ...(baseSvc.vaultAppRoleRef !== undefined ? { vaultAppRoleRef: baseSvc.vaultAppRoleRef } : {}),
      ...(baseSvc.vaultAppRoleId !== undefined ? { vaultAppRoleId: baseSvc.vaultAppRoleId } : {}),
      ...(baseSvc.natsCredentialRef !== undefined ? { natsCredentialRef: baseSvc.natsCredentialRef } : {}),
      ...(baseSvc.natsCredentialId !== undefined ? { natsCredentialId: baseSvc.natsCredentialId } : {}),
    };
  });

  return {
    ...parsed,
    services,
    ...(base.inputs !== undefined ? { inputs: base.inputs } : {}),
    ...(base.vault !== undefined ? { vault: base.vault } : {}),
    ...(base.nats !== undefined ? { nats: base.nats } : {}),
    ...(base.requires !== undefined ? { requires: base.requires } : {}),
  };
}

/**
 * True when a template version carries sections the YAML Code view can't show
 * (and would strip on save without the merge above). Used to render the
 * "…will be preserved" notice in the Code view.
 */
export function versionHasUnrepresentedSections(
  version: StackTemplateVersionInfo,
): boolean {
  if (version.inputs && version.inputs.length > 0) return true;
  if (version.requires && version.requires.length > 0) return true;
  if (version.vault) return true;
  if (version.nats) return true;
  return (version.services ?? []).some(
    (s) =>
      (s.addons && Object.keys(s.addons).length > 0) ||
      s.poolConfig != null ||
      s.jobPoolConfig != null ||
      s.natsRole != null ||
      s.natsSigner != null ||
      s.vaultAppRoleRef != null ||
      s.natsCredentialRef != null,
  );
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
