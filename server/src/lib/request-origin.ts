import type { Request } from "express";

/**
 * Best-effort `protocol://host` origin for an incoming request. Used as a
 * fallback for building OAuth redirect URIs during onboarding, before the
 * operator has configured `system.public_url`. Returns null when the Host
 * header is absent. Honours `X-Forwarded-*` only insofar as Express's
 * `req.protocol` / `req.hostname` do (i.e. when `trust proxy` is set).
 */
export function requestOrigin(req: Request): string | null {
  const host = req.get("host");
  if (!host) return null;
  return `${req.protocol}://${host}`;
}
