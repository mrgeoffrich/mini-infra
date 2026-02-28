/**
 * Authentication Middleware Public Interface
 *
 * This file provides a clean public API for authentication middleware by re-exporting
 * selected functions from the implementation in ../lib/auth-middleware.ts.
 *
 * Routes should import authentication middleware from this file rather than directly
 * from the lib directory. This pattern provides:
 *
 * - Consistent import paths across the application
 * - Clean separation between implementation and public interface
 * - Flexibility to modify exports without changing route imports
 * - Better maintainability and code organization
 *
 * Usage in routes:
 *   import { requireAuth, requireAuthorization } from '../middleware/auth';
 */

export {
  requireAuth,
  requireAuthorization,
  requireOwnership,
  createAuthErrorResponse,
  getAuthenticatedUser,
  isAuthenticated,
  getAuthMethod
} from '../lib/auth-middleware';

export {
  requireSessionOrApiKey,
  getCurrentUserId,
  getCurrentUser
} from '../lib/api-key-middleware';

export { requirePermission } from '../lib/permission-middleware';

export type { AuthErrorType, AuthErrorResponse } from '../lib/auth-middleware';