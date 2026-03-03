// Backwards-compatible re-exports from the refactored dataplane module.
// All 12 interfaces, the main client class, TransactionManager, and RetryableHAProxyClient
// are re-exported so that existing import paths continue to work unchanged.

export {
  // Main client class
  HAProxyDataPlaneClient,
  // Helper classes
  TransactionManager,
  RetryableHAProxyClient,
  // Interfaces
  type ServerConfig,
  type BackendConfig,
  type FrontendConfig,
  type FrontendRule,
  type Backend,
  type Server,
  type ServerStats,
  type BackendStats,
  type HAProxyEndpointInfo,
  type Version,
  type ApiResponse,
  type ErrorResponse,
} from './dataplane';

export { default } from './dataplane';
