import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

export interface LoggingContext {
  requestId?: string;
  userId?: string;
  operationId?: string;
}

const storage = new AsyncLocalStorage<LoggingContext>();

export function runWithContext<T>(ctx: LoggingContext, fn: () => T): T {
  const parent = storage.getStore() ?? {};
  const merged: LoggingContext = { ...parent, ...ctx };
  return storage.run(merged, fn);
}

export function getContext(): LoggingContext | undefined {
  return storage.getStore();
}

export function setUserId(userId: string): void {
  const current = storage.getStore();
  if (current) {
    current.userId = userId;
  }
}

export function setOperationId(operationId: string): void {
  const current = storage.getStore();
  if (current) {
    current.operationId = operationId;
  }
}

/**
 * Wrap work in a fresh operation scope using `<prefix>-<uuid>` as the
 * operationId. Use at the top of scheduler ticks, scheduled job runs, and
 * non-request-triggered work so downstream logs can be grouped via the
 * operationId structured field.
 */
export function withOperation<T>(
  prefix: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const operationId = `${prefix}-${randomUUID()}`;
  return runWithContext({ operationId }, fn);
}
