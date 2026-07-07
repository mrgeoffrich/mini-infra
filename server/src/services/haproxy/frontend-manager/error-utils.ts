import { CustomError } from "../../../lib/error-handler";

/**
 * Re-throws taxonomy errors (`ConflictError`/`NotFoundError`/`ValidationError`/
 * `InternalError`/etc.) unchanged instead of letting a catch-all wrap them into
 * a fresh `InternalError` — the wrap is only meant for genuinely-opaque
 * DataPlane/unexpected failures, not for domain errors raised a few lines up
 * in the same try-block or bubbling up from
 * `HAProxyDataPlaneClientBase.handleApiError` (e.g. a real 409 version
 * conflict or 404 resource-not-found). Shared across the `frontend-manager/`
 * modules so each generic-wrap catch block applies the same rule.
 */
export function rethrowIfTaxonomyError(error: unknown): void {
  if (error instanceof CustomError) {
    throw error;
  }
}
