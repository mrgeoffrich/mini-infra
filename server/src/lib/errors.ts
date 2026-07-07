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

/**
 * 500 — a genuine internal invariant or programmer error that is NOT
 * user-actionable. The sanctioned escape hatch for the `no-restricted-syntax`
 * ban on raw `throw new Error` in `src/services` (see server/eslint.config.js):
 * reach for this only when the failure means "this should never happen"
 * (boot-order, defense-in-depth, an unexpected SDK failure) — never to mask a
 * user-actionable 4xx. `isOperational = false`, so the central middleware logs
 * it with a stack trace and hides the message from clients in production, the
 * same as it always has for a raw `Error`.
 */
export class InternalError extends CustomError {
  constructor(message: string, opts?: AppErrorOptions) {
    super(message, 500, false, ErrorCode.INTERNAL, opts);
  }
}
