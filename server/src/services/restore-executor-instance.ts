import { RestoreExecutorService } from './restore-executor';

let instance: RestoreExecutorService | null = null;

export function setRestoreExecutorService(service: RestoreExecutorService): void {
  instance = service;
}

export function getRestoreExecutorService(): RestoreExecutorService {
  if (!instance) {
    throw new Error('RestoreExecutorService not initialized. Call setRestoreExecutorService first.');
  }
  return instance;
}