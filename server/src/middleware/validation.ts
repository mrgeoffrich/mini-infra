import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { servicesLogger } from '../lib/logger-factory';

const logger = servicesLogger();

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
        const errors = result.error.issues.map((err: any) => ({
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
      if (source === 'body') {
        req.body = result.data;
      } else if (source === 'query') {
        req.query = result.data as any;
      } else {
        req.params = result.data as any;
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