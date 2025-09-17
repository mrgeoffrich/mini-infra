// Re-export auth middleware from lib for consistent import paths
export {
  requireAuth,
  requireAuthorization,
  requireOwnership,
  createAuthErrorResponse
} from '../lib/auth-middleware';

export type { AuthErrorType, AuthErrorResponse } from '../lib/auth-middleware';