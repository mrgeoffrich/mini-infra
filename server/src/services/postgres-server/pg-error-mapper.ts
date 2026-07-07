import { ErrorCode } from "@mini-infra/types";
import { AppErrorResource } from "../../lib/error-handler";
import { ConflictError, ForbiddenError, InternalError } from "../../lib/errors";

/**
 * Classifies a failure raised by a live query against a managed PostgreSQL
 * server (CREATE/DROP/ALTER/GRANT/REVOKE, all issued with inputs we've
 * already validated at the request boundary) into the shared error taxonomy
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md §4.2).
 *
 * PostgreSQL reports the specific failure via a SQLSTATE on `error.code`
 * (see https://www.postgresql.org/docs/current/errcodes-appendix.html) —
 * only SQLSTATEs with an unambiguous, user-actionable meaning are promoted
 * to a 4xx here. Everything else (SQL we generated being malformed, a
 * dropped connection, disk full, ...) is a genuine internal failure and
 * stays a 500 via `InternalError` — never launder an invariant into a 4xx
 * just because *some* failures from this code path are user-actionable.
 */

/** duplicate_database / duplicate_object / unique_violation — the named resource already exists. */
const DUPLICATE_OBJECT_SQLSTATES = new Set(["42P04", "42710", "23505"]);

/** insufficient_privilege — the server's admin credential can't perform this operation. */
const PERMISSION_DENIED_SQLSTATES = new Set(["42501"]);

/** dependent_objects_still_exist / object_in_use — e.g. dropping a user that still owns objects. */
const OBJECT_IN_USE_SQLSTATES = new Set(["2BP01", "55006"]);

function sqlState(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

export interface PostgresOperationErrorContext {
  /** Human-readable summary of the failed operation, e.g. "Failed to create database". */
  fallbackMessage: string;
  resource: AppErrorResource;
  action: string;
}

/** Maps a caught error from a managed-server query into a taxonomy error or `InternalError`. */
export function mapPostgresOperationError(
  error: unknown,
  ctx: PostgresOperationErrorContext,
): Error {
  const code = sqlState(error);
  const detail = error instanceof Error ? error.message : String(error);

  if (code && DUPLICATE_OBJECT_SQLSTATES.has(code)) {
    return new ConflictError(
      ErrorCode.PG_RESOURCE_ALREADY_EXISTS,
      `${ctx.fallbackMessage}: already exists`,
      { resource: ctx.resource, action: ctx.action },
    );
  }

  if (code && PERMISSION_DENIED_SQLSTATES.has(code)) {
    return new ForbiddenError(
      ErrorCode.PG_PERMISSION_DENIED,
      `${ctx.fallbackMessage}: permission denied on the PostgreSQL server`,
      { resource: ctx.resource, action: ctx.action },
    );
  }

  if (code && OBJECT_IN_USE_SQLSTATES.has(code)) {
    return new ConflictError(
      ErrorCode.PG_RESOURCE_IN_USE,
      `${ctx.fallbackMessage}: still in use`,
      { resource: ctx.resource, action: ctx.action },
    );
  }

  return new InternalError(`${ctx.fallbackMessage}: ${detail}`);
}
