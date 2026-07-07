import type { ErrorRequestHandler } from 'express';
import { getLogger } from '../../lib/logger-factory';
import { isDockerConnectionError } from '../../services/stacks/utils';

const logger = getLogger("stacks", "stacks-error-handler");

/**
 * Router-scoped error handler for /api/stacks, mounted last in
 * `routes/stacks/index.ts` — it runs BEFORE the app-level central error
 * middleware (`server/src/lib/error-handler.ts`), so it must forward
 * anything it doesn't own via `next(err)` rather than swallowing it into a
 * bespoke body. The only case genuinely local to this router is mapping a
 * Docker-connectivity failure to 503 (no taxonomy class covers "external
 * dependency unavailable" yet) — every other error (including every
 * taxonomy error thrown by the stacks services/routes) is forwarded so the
 * central middleware renders the one shared envelope.
 */
export const stacksErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (isDockerConnectionError(err)) {
    logger.warn(
      { method: req.method, path: req.path },
      'Docker unavailable while handling stack request',
    );
    return res.status(503).json({ success: false, message: 'Docker is unavailable' });
  }

  next(err);
};
