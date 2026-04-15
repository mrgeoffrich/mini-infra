import type { ErrorRequestHandler } from 'express';
import { getLogger } from '../../lib/logger-factory';
import { isDockerConnectionError } from '../../services/stacks/utils';

const logger = getLogger("stacks", "stacks-error-handler");

/**
 * Router-scoped error handler for /api/stacks. Preserves the legacy
 * `{ success: false, message }` response envelope that stack API consumers
 * expect, and maps Docker connection errors to 503 (matching the previous
 * per-handler behaviour).
 */
export const stacksErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (isDockerConnectionError(err)) {
    logger.warn(
      { method: req.method, path: req.path },
      'Docker unavailable while handling stack request',
    );
    return res.status(503).json({ success: false, message: 'Docker is unavailable' });
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error(
    { err, method: req.method, path: req.path, params: req.params },
    'Stack route error',
  );
  res.status(500).json({ success: false, message });
};
