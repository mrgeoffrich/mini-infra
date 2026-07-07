import { ErrorCode } from "@mini-infra/types";
import { AppErrorOptions, CustomError } from "./error-handler";

/**
 * Server error taxonomy (docs/planning/not-shipped/error-handling-overhaul-plan.md, §4.2).
 *
 * Each subclass fixes its own HTTP status so services never pass a raw
 * number — callers only supply a machine `code` (from `ErrorCode`), a human
 * `message`, and optionally a `resource`/`action`/`details`. All instances
 * are operational (`isOperational = true`), so the central middleware
 * (`server/src/lib/error-handler.ts`) maps them to the shared response
 * envelope instead of a generic 500.
 *
 * Genuine internal invariants (programmer errors that *should* be 500) keep
 * throwing a plain `Error` — do not reach for these classes to launder a
 * correctness bug into a client-friendly 4xx.
 */

/** 409 — the requested resource already exists / conflicts with current state. */
export class ConflictError extends CustomError {
  constructor(code: ErrorCode, message: string, opts?: AppErrorOptions) {
    super(message, 409, true, code, opts);
  }
}

/** 404 — the referenced resource does not exist. */
export class NotFoundError extends CustomError {
  constructor(code: ErrorCode, message: string, opts?: AppErrorOptions) {
    super(message, 404, true, code, opts);
  }
}

/** 400 — the request failed a business-rule validation (distinct from Zod's schema-shape validation). */
export class ValidationError extends CustomError {
  constructor(code: ErrorCode, message: string, opts?: AppErrorOptions) {
    super(message, 400, true, code, opts);
  }
}

/** 401 — the caller is not authenticated. */
export class UnauthorizedError extends CustomError {
  constructor(code: ErrorCode, message: string, opts?: AppErrorOptions) {
    super(message, 401, true, code, opts);
  }
}

/** 403 — the caller is authenticated but not permitted to perform the action. */
export class ForbiddenError extends CustomError {
  constructor(code: ErrorCode, message: string, opts?: AppErrorOptions) {
    super(message, 403, true, code, opts);
  }
}
