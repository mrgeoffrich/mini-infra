/**
 * Typed failures raised by the Phase 1 NATS identity re-key guard.
 *
 * The NATS identity is the operator seed (Vault KV `shared/nats-operator`)
 * plus the per-account seeds. The authoritative record of *which* identity is
 * current lives in the DB (`natsState.operatorPublic` / `natsAccount.publicKey`).
 *
 * These errors are thrown by
 * `NatsControlPlaneService.assertRecordedIdentitiesHaveSeeds()` when the DB
 * records an identity that Vault can no longer back with a matching seed.
 * `applyConfig` aborts on them rather than minting a fresh identity — a
 * regeneration here would orphan every credential already issued against the
 * recorded identity (e.g. the egress agents' baked-in `NATS_CREDS`), which is
 * exactly the production incident Phase 1 prevents.
 */

/** Base class so callers can `instanceof NatsIdentityError` to catch both. */
export class NatsIdentityError extends Error {
  constructor(
    message: string,
    /** Human-readable identity label, e.g. `operator mini-infra-operator`. */
    readonly identityLabel: string,
    /** Vault KV path the seed was expected at. */
    readonly kvPath: string,
    /** The public key the DB records for this identity. */
    readonly recordedPublicKey: string,
  ) {
    super(message);
    // `new.target` resolves to the concrete subclass being constructed.
    this.name = new.target.name;
  }
}

/**
 * The DB records a public key for an identity, but Vault returned no seed for
 * it (a `path_not_found` / `field_not_found`). This is Vault data loss or a
 * post-unseal read race — never a first boot. Regenerating would re-key.
 */
export class NatsIdentityMissing extends NatsIdentityError {
  constructor(identityLabel: string, kvPath: string, recordedPublicKey: string) {
    super(
      `NATS identity seed missing from Vault for ${identityLabel} ` +
        `(recorded public key ${recordedPublicKey}, expected seed at '${kvPath}') — ` +
        `refusing to regenerate to avoid orphaning credentials`,
      identityLabel,
      kvPath,
      recordedPublicKey,
    );
  }
}

/**
 * The seed IS present in Vault, but the public key it derives to does not
 * match the one the DB records — the stored seed belongs to a *different*
 * identity. Proceeding would silently swap identities under running agents,
 * so this aborts with the same semantics as {@link NatsIdentityMissing}.
 */
export class NatsIdentityMismatch extends NatsIdentityError {
  constructor(
    identityLabel: string,
    kvPath: string,
    recordedPublicKey: string,
    /** The public key actually derived from the stored seed. */
    readonly derivedPublicKey: string,
  ) {
    super(
      `NATS identity seed at '${kvPath}' for ${identityLabel} derives public key ` +
        `${derivedPublicKey}, which does not match the recorded ${recordedPublicKey} — ` +
        `refusing to proceed to avoid orphaning credentials`,
      identityLabel,
      kvPath,
      recordedPublicKey,
    );
  }
}
