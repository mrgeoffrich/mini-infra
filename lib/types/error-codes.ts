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

  // Environments / networks
  ENVIRONMENT_NAME_EXISTS: "ENVIRONMENT_NAME_EXISTS",
  ENVIRONMENT_NETWORK_TYPE_CONFLICT: "ENVIRONMENT_NETWORK_TYPE_CONFLICT",
  ENVIRONMENT_NOT_FOUND: "ENVIRONMENT_NOT_FOUND",
  ENVIRONMENT_HAPROXY_MIGRATION_IN_PROGRESS: "ENVIRONMENT_HAPROXY_MIGRATION_IN_PROGRESS",
  DOCKER_NETWORK_NOT_FOUND: "DOCKER_NETWORK_NOT_FOUND",
  DOCKER_NETWORK_IN_USE: "DOCKER_NETWORK_IN_USE",
  MANAGED_NETWORK_NOT_FOUND: "MANAGED_NETWORK_NOT_FOUND",

  // Generic, cross-domain fallbacks emitted by the central error middleware
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
