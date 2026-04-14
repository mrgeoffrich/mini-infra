import type { Request } from 'express';

/**
 * Reads the authenticated user's id from the request. Mirrors the pattern the
 * JWT/API-key middleware uses to attach `req.user` — returns `undefined` if
 * the request is unauthenticated (e.g. internal automation calls).
 */
export function getUserId(req: Request): string | undefined {
  return (req as { user?: { id?: string } }).user?.id;
}
