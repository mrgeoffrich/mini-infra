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

  // Containers / images / volumes (Phase 7)
  CONTAINER_NOT_FOUND: "CONTAINER_NOT_FOUND",
  CONTAINER_ALREADY_IN_STATE: "CONTAINER_ALREADY_IN_STATE",
  CONTAINER_NOT_RUNNING: "CONTAINER_NOT_RUNNING",
  DOCKER_NOT_CONNECTED: "DOCKER_NOT_CONNECTED",
  IMAGE_NOT_FOUND: "IMAGE_NOT_FOUND",
  IMAGE_AUTH_FAILED: "IMAGE_AUTH_FAILED",
  VOLUME_NOT_FOUND: "VOLUME_NOT_FOUND",
  VOLUME_IN_USE: "VOLUME_IN_USE",
  VOLUME_FILE_NOT_FOUND: "VOLUME_FILE_NOT_FOUND",

  // Generic, cross-domain fallbacks emitted by the central error middleware
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
