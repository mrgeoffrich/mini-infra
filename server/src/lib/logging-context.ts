import { AsyncLocalStorage } from "async_hooks";

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
