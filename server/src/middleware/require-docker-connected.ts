import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ErrorCode } from '@mini-infra/types';
import DockerService from '../services/docker';
import { CustomError } from '../lib/error-handler';

/**
 * Short-circuits with a taxonomy 503 (`DOCKER_NOT_CONNECTED`) when the
 * Docker daemon is not reachable, so every consumer gets the same envelope
 * via the central middleware instead of hand-rolling its own JSON body
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md, Phase 7).
 */
export function requireDockerConnected(): RequestHandler {
  return (_req: Request, _res: Response, next: NextFunction) => {
    const docker = DockerService.getInstance();
    if (!docker.isConnected()) {
      next(
        new CustomError(
          'Docker service is not available. Please try again later.',
          503,
          true,
          ErrorCode.DOCKER_NOT_CONNECTED,
          { action: 'Check the Docker connection in Settings and try again.' },
        ),
      );
      return;
    }
    next();
  };
}
