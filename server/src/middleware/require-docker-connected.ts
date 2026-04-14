import type { Request, Response, NextFunction, RequestHandler } from 'express';
import DockerService from '../services/docker';

/** Short-circuits with 503 when the Docker daemon is not reachable. */
export function requireDockerConnected(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    const docker = DockerService.getInstance();
    if (!docker.isConnected()) {
      res.status(503).json({ success: false, message: 'Docker not connected' });
      return;
    }
    next();
  };
}
