import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

const STACK_KEY = Symbol('stack');

/** Options accepted by `requireStack()` — forwarded to `prisma.stack.findUnique`. */
export interface RequireStackOptions {
  select?: Prisma.StackSelect;
  include?: Prisma.StackInclude;
  /** URL param name to read the stack id from. Defaults to `'stackId'`. */
  param?: string;
}

/**
 * Middleware that loads a Stack by route param and 404s if not found.
 * The loaded row is attached to the request via a private symbol; callers
 * read it with `getLoadedStack(req)` for type-safe access without module
 * augmentation.
 *
 * Variants (via options):
 *   - `requireStack()` — full row
 *   - `requireStack({ select: { id: true } })` — id-only (existence check)
 *   - `requireStack({ include: { services: true } })` — with relations
 */
export function requireStack(options: RequireStackOptions = {}): RequestHandler {
  const { select, include, param = 'stackId' } = options;
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stackId = String(req.params[param]);
      const stack = await prisma.stack.findUnique({
        where: { id: stackId },
        ...(select ? { select } : {}),
        ...(include ? { include } : {}),
      } as Prisma.StackFindUniqueArgs);

      if (!stack) {
        res.status(404).json({ success: false, message: 'Stack not found' });
        return;
      }

      (req as unknown as Record<symbol, unknown>)[STACK_KEY] = stack;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Retrieve the stack loaded by a preceding `requireStack()` middleware. */
export function getLoadedStack<T = Record<string, unknown>>(req: Request): T {
  return (req as unknown as Record<symbol, unknown>)[STACK_KEY] as T;
}
