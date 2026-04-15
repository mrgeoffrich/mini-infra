import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getLogger } from '../lib/logger-factory';

const logger = getLogger("platform", "validation");

// Private symbol keys — not exported, so callers must use the typed accessors below
// and cannot bypass the type guarantee by reading req.validatedQuery directly.
const _validatedQuery = Symbol('validatedQuery');
const _validatedParams = Symbol('validatedParams');

// TypeScript 4.4+ supports symbol index signatures
type SymbolKeyed = { [key: symbol]: unknown };

export function validateRequest<TSchema extends z.ZodSchema>(
  schema: TSchema,
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

      // For body, write back to req.body (already typed as any in Express).
      // For query/params, store under private symbol keys so the Express Request
      // interface needs no augmentation — use getValidatedQuery/getValidatedParams
      // to retrieve with the correct inferred type.
      if (source === 'body') {
        req.body = result.data;
      } else if (source === 'query') {
        (req as unknown as SymbolKeyed)[_validatedQuery] = result.data;
      } else {
        (req as unknown as SymbolKeyed)[_validatedParams] = result.data;
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

/**
 * Retrieve the validated query string parsed by a preceding
 * `validateRequest(schema, 'query')` middleware.  Pass the same schema to get
 * a properly typed return value without any cast at the call site.
 */
export function getValidatedQuery<T extends z.ZodSchema>(req: Request, schema: T): z.output<T> {
  void schema; // used only for type inference
  return (req as unknown as SymbolKeyed)[_validatedQuery] as z.output<T>;
}

/**
 * Retrieve the validated route params parsed by a preceding
 * `validateRequest(schema, 'params')` middleware.  Pass the same schema to get
 * a properly typed return value without any cast at the call site.
 */
export function getValidatedParams<T extends z.ZodSchema>(req: Request, schema: T): z.output<T> {
  void schema; // used only for type inference
  return (req as unknown as SymbolKeyed)[_validatedParams] as z.output<T>;
}
