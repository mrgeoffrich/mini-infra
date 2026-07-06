// ====================
// NATS Types
// ====================

export type NatsRetentionPolicy = "limits" | "interest" | "workqueue";
export type NatsStorageType = "file" | "memory";
export type NatsDeliverPolicy = "all" | "last" | "new" | "by_start_sequence" | "by_start_time" | "last_per_subject";
export type NatsAckPolicy = "none" | "all" | "explicit";

export interface NatsStatus {
  configured: boolean;
  reachable: boolean;
  clientUrl: string | null;
  monitorUrl: string | null;
  stackId: string | null;
  bootstrappedAt: string | null;
  lastAppliedAt: string | null;
  operatorPublic: string | null;
  systemAccountPublic: string | null;
  accounts: number;
  credentialProfiles: number;
  streams: number;
  consumers: number;
  /**
   * ISO timestamp of the last successful identity-seed backup (operator +
   * account NKey seeds captured into the encrypted self-backup artifact), or
   * `null` if no seed backup has been recorded yet. Populated from the
   * `nats-seed-backup` marker written by the self-backup executor.
   */
  lastIdentitySeedBackupAt: string | null;
  /** Number of identity seeds captured in that last backup (operator + accounts). */
  lastIdentitySeedBackupCount: number | null;
  errorMessage?: string;
}

/** Outcome of restoring one identity seed back into Vault KV. */
export interface NatsIdentitySeedRestoreEntry {
  /** Human label, e.g. `operator mini-infra-operator` / `account foo`. */
  label: string;
  /** Canonical Vault KV path the seed belongs at. */
  kvPath: string;
  /**
   * - `restored`  — the path was empty/missing and the backed-up seed was written.
   * - `unchanged` — the same seed is already present (idempotent no-op).
   * - `conflict`  — a *different* seed is present; not overwritten unless `force`.
   */
  outcome: "restored" | "unchanged" | "conflict";
  /** Public key derived from the backed-up seed. */
  backupPublicKey: string;
  /** Public key currently in Vault (only set for `unchanged` / `conflict`). */
  currentPublicKey?: string | null;
}

/** Aggregate result of an identity-seed restore. */
export interface NatsIdentitySeedRestoreResult {
  /**
   * `true` when the restore was applied. `false` means at least one seed
   * conflicted with a present-but-different seed and `force` was not set, so
   * NOTHING was written (all-or-nothing on conflict for safety).
   */
  applied: boolean;
  restored: number;
  unchanged: number;
  conflicts: number;
  entries: NatsIdentitySeedRestoreEntry[];
}

export interface NatsAccountInfo {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  seedKvPath: string;
  publicKey: string | null;
  jwt: string | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NatsCredentialProfileInfo {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  accountId: string;
  accountName: string;
  publishAllow: string[];
  subscribeAllow: string[];
  ttlSeconds: number;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NatsStreamInfo {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  description: string | null;
  subjects: string[];
  retention: NatsRetentionPolicy;
  storage: NatsStorageType;
  maxMsgs: number | null;
  maxBytes: number | null;
  maxAgeSeconds: number | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NatsConsumerInfo {
  id: string;
  streamId: string;
  streamName: string;
  name: string;
  durableName: string | null;
  description: string | null;
  filterSubject: string | null;
  deliverPolicy: NatsDeliverPolicy;
  ackPolicy: NatsAckPolicy;
  maxDeliver: number | null;
  ackWaitSeconds: number | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNatsAccountRequest {
  name: string;
  displayName: string;
  description?: string;
}

export interface UpdateNatsAccountRequest {
  displayName?: string;
  description?: string | null;
}

export interface CreateNatsCredentialProfileRequest {
  name: string;
  displayName: string;
  description?: string;
  accountId: string;
  publishAllow: string[];
  subscribeAllow: string[];
  ttlSeconds?: number;
}

export interface UpdateNatsCredentialProfileRequest {
  displayName?: string;
  description?: string | null;
  accountId?: string;
  publishAllow?: string[];
  subscribeAllow?: string[];
  ttlSeconds?: number;
}

export interface CreateNatsStreamRequest {
  name: string;
  accountId: string;
  description?: string;
  subjects: string[];
  retention?: NatsRetentionPolicy;
  storage?: NatsStorageType;
  maxMsgs?: number | null;
  maxBytes?: number | null;
  maxAgeSeconds?: number | null;
}

export interface UpdateNatsStreamRequest {
  accountId?: string;
  description?: string | null;
  subjects?: string[];
  retention?: NatsRetentionPolicy;
  storage?: NatsStorageType;
  maxMsgs?: number | null;
  maxBytes?: number | null;
  maxAgeSeconds?: number | null;
}

export interface CreateNatsConsumerRequest {
  streamId: string;
  name: string;
  durableName?: string;
  description?: string;
  filterSubject?: string;
  deliverPolicy?: NatsDeliverPolicy;
  ackPolicy?: NatsAckPolicy;
  maxDeliver?: number | null;
  ackWaitSeconds?: number | null;
}

export interface UpdateNatsConsumerRequest {
  streamId?: string;
  durableName?: string | null;
  description?: string | null;
  filterSubject?: string | null;
  deliverPolicy?: NatsDeliverPolicy;
  ackPolicy?: NatsAckPolicy;
  maxDeliver?: number | null;
  ackWaitSeconds?: number | null;
}

export interface MintNatsCredentialResponse {
  profileId: string;
  profileName: string;
  expiresAt: string | null;
  creds: string;
}

export interface NatsAppliedEvent {
  operationId: string;
  success: boolean;
  message?: string;
}
