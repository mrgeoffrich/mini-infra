// ====================
// Error Codes
// ====================
//
// Machine-readable error codes shared between client and server. No runtime
// deps (per the lib zero-external-dependency invariant — see lib/CLAUDE.md).
//
// Naming rule: SCREAMING_SNAKE, shaped `<DOMAIN>_<REASON>`. Seeded here with
// only what the current phase of the error-handling overhaul needs
// (docs/planning/not-shipped/error-handling-overhaul-plan.md, §4.1); each
// later phase adds its own domain's codes as it migrates.
export const ErrorCode = {
  // Postgres backup domain (Phase 1 reference migration)
  POSTGRES_DB_CONFIG_EXISTS: "POSTGRES_DB_CONFIG_EXISTS",
  POSTGRES_BACKUP_CONFIG_EXISTS: "POSTGRES_BACKUP_CONFIG_EXISTS",

  // NATS
  // — identity re-key guard (nats-identity-errors.ts / NatsControlPlaneService)
  NATS_IDENTITY_SEED_MISSING: "NATS_IDENTITY_SEED_MISSING",
  NATS_IDENTITY_SEED_MISMATCH: "NATS_IDENTITY_SEED_MISMATCH",
  // — identity-seed backup/restore (nats-identity-seed-backup.ts, self-backup-seed-restore.ts)
  NATS_SELF_BACKUP_NOT_FOUND: "NATS_SELF_BACKUP_NOT_FOUND",
  NATS_SELF_BACKUP_NO_SEED_ENTRY: "NATS_SELF_BACKUP_NO_SEED_ENTRY",
  NATS_SEED_BACKUP_DECRYPT_FAILED: "NATS_SEED_BACKUP_DECRYPT_FAILED",
  NATS_IDENTITY_SEED_RESTORE_CONFLICT: "NATS_IDENTITY_SEED_RESTORE_CONFLICT",
  // — account/credential/stream/consumer CRUD (nats-control-plane-service.ts)
  NATS_ACCOUNT_EXISTS: "NATS_ACCOUNT_EXISTS",
  NATS_ACCOUNT_NOT_FOUND: "NATS_ACCOUNT_NOT_FOUND",
  NATS_SYSTEM_ACCOUNT_PROTECTED: "NATS_SYSTEM_ACCOUNT_PROTECTED",
  NATS_CREDENTIAL_PROFILE_EXISTS: "NATS_CREDENTIAL_PROFILE_EXISTS",
  NATS_CREDENTIAL_PROFILE_NOT_FOUND: "NATS_CREDENTIAL_PROFILE_NOT_FOUND",
  NATS_STREAM_EXISTS: "NATS_STREAM_EXISTS",
  NATS_STREAM_NOT_FOUND: "NATS_STREAM_NOT_FOUND",
  NATS_CONSUMER_EXISTS: "NATS_CONSUMER_EXISTS",
  NATS_CONSUMER_NOT_FOUND: "NATS_CONSUMER_NOT_FOUND",
  NATS_INVALID_NAME: "NATS_INVALID_NAME",
  NATS_INVALID_SUBJECT: "NATS_INVALID_SUBJECT",
  // — stack-apply NATS phase (stack-nats-apply-orchestrator.ts)
  NATS_NOT_CONFIGURED: "NATS_NOT_CONFIGURED",
  NATS_SUBJECT_PREFIX_NOT_ALLOWLISTED: "NATS_SUBJECT_PREFIX_NOT_ALLOWLISTED",
  NATS_IMPORT_INVALID: "NATS_IMPORT_INVALID",
  NATS_IMPORT_PRODUCER_NOT_FOUND: "NATS_IMPORT_PRODUCER_NOT_FOUND",
  NATS_IMPORT_PRODUCER_NOT_READY: "NATS_IMPORT_PRODUCER_NOT_READY",
  // — subject-prefix allowlist admin CRUD (nats-prefix-allowlist-service.ts)
  NATS_PREFIX_ALLOWLIST_INVALID: "NATS_PREFIX_ALLOWLIST_INVALID",
  NATS_PREFIX_ALLOWLIST_NOT_FOUND: "NATS_PREFIX_ALLOWLIST_NOT_FOUND",
  NATS_PREFIX_ALLOWLIST_OVERLAP: "NATS_PREFIX_ALLOWLIST_OVERLAP",

  // Generic, cross-domain fallbacks emitted by the central error middleware
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
