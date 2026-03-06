// Re-export the composed client class and all supporting types/classes
export { HAProxyDataPlaneClient } from './client';
export * from './types';
export { type HttpRequestRule } from './mixin-http-rules';
export { TransactionManager } from './transaction-manager';
export { RetryableHAProxyClient } from './retryable-client';
export { default } from './client';
