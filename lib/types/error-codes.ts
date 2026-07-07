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

  // Generic, cross-domain fallbacks emitted by the central error middleware
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INTERNAL: "INTERNAL",

  // Auth / API keys / users / permissions (Phase 9)
  API_KEY_NOT_FOUND: "API_KEY_NOT_FOUND",
  PERMISSION_PRESET_NOT_FOUND: "PERMISSION_PRESET_NOT_FOUND",
  PERMISSION_PRESET_NAME_EXISTS: "PERMISSION_PRESET_NAME_EXISTS",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  USER_EMAIL_EXISTS: "USER_EMAIL_EXISTS",
  USER_SELF_DELETE_FORBIDDEN: "USER_SELF_DELETE_FORBIDDEN",
  AUTH_SETUP_ALREADY_COMPLETE: "AUTH_SETUP_ALREADY_COMPLETE",
  AUTH_SETUP_NOT_IN_PROGRESS: "AUTH_SETUP_NOT_IN_PROGRESS",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_ACCOUNT_LOCKED: "AUTH_ACCOUNT_LOCKED",
  AUTH_EMAIL_NOT_ALLOWED: "AUTH_EMAIL_NOT_ALLOWED",
  AUTH_PASSWORD_TOO_WEAK: "AUTH_PASSWORD_TOO_WEAK",
  AUTH_RECOVERY_TOKEN_INVALID: "AUTH_RECOVERY_TOKEN_INVALID",
  AUTH_CURRENT_PASSWORD_REQUIRED: "AUTH_CURRENT_PASSWORD_REQUIRED",
  AUTH_CURRENT_PASSWORD_INCORRECT: "AUTH_CURRENT_PASSWORD_INCORRECT",
  AUTH_NO_PASSWORD_SET: "AUTH_NO_PASSWORD_SET",
  AUTH_NOT_AUTHENTICATED: "AUTH_NOT_AUTHENTICATED",
  AUTH_GOOGLE_OAUTH_CREDENTIALS_REQUIRED: "AUTH_GOOGLE_OAUTH_CREDENTIALS_REQUIRED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
