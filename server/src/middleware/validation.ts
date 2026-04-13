import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { servicesLogger } from '../lib/logger-factory';

const logger = servicesLogger();

// Extend Express Request type to include validated data
// Express 5 makes req.query read-only, so we store validated query data separately
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validatedQuery?: unknown;
      validatedParams?: unknown;
    }
  }
}

export function validateRequest(
  schema: z.ZodSchema,
  source: 'body' | 'query' | 'params' = 'body'
) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = source === 'body' ? req.body :
                   source === 'query' ? req.query :
                   req.params;

      const result = schema.safeParse(data);

      if (!result.success) {
        const errors = result.error.issues.map((err) => ({
          code: err.code,
          path: err.path,
          message: err.message,
          expected: 'expected' in err ? err.expected : undefined,
          received: 'received' in err ? err.received : undefined
        }));

        logger.warn({
          source,
          errors,
          data
        }, 'Request validation failed');

        return res.status(400).json({
          error: 'Validation Error',
          message: 'Request data validation failed',
          details: errors,
          timestamp: new Date().toISOString()
        });
      }

      // Replace the original data with the parsed/transformed data
      // Express 5 Note: req.query and req.params are read-only getters
      // Store validated query/params in custom properties instead
      if (source === 'body') {
        req.body = result.data;
      } else if (source === 'query') {
        req.validatedQuery = result.data;
      } else {
        req.validatedParams = result.data;
      }

      next();
    } catch (error) {
      logger.error({ error, source }, 'Validation middleware error');

      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Request validation processing failed',
        timestamp: new Date().toISOString()
      });
    }
  };
}