# Failed Tests Summary

**Test Run Date:** 2025-09-05

**Overall Results:**
- Test Suites: 22 failed, 3 passed, 25 total
- Tests: 113 failed, 2 skipped, 318 passed, 433 total

---

## 1. `src/services/__tests__/docker-config.test.ts` ✅ **FIXED**

### Issues Fixed:
- **Docker connectivity validation failing** - Fixed ping result validation to accept boolean `true` responses
- **Custom Docker host validation failing** - Fixed by allowing boolean `true` as valid ping response
- **Error message mismatch** - Fixed by correcting ping validation logic to handle boolean responses

### Previously Failed Tests (Now Passing):
1. `DockerConfigService › validate › should validate Docker connectivity successfully` ✅
2. `DockerConfigService › validate › should use custom Docker host from settings` ✅
3. `DockerConfigService › validate › should handle Docker info/version API errors gracefully` ✅

### Fix Summary:
Updated the ping validation logic in `docker-config.ts` to accept both string "OK" responses and boolean `true` responses from Docker ping API.

---

## 2. `src/__tests__/api-key-service.test.ts`

### Issues:
- **Hash collision** - Two different API key hashes are producing the same result
- Expected different hashes but got: `"779cb3d0684b887364d68ee1054c33223be544fe320ee66168c4d2a4a5e1bf5b"`

### Failed Tests:
1. `API Key Generation and Validation › hashApiKey › should handle environment secret correctly`

---

## 3. `src/services/__tests__/docker.test.ts`

### Issues:
- **Docker constructor not being called** - Mock Docker constructor expected to be called with socket path but wasn't called at all
- **Container operations failing** - Multiple container-related operations not working as expected

### Failed Tests:
1. `DockerService › Singleton Pattern › should initialize Docker client with correct configuration`
2. Multiple other Docker service tests (output truncated)

---

## 4. `src/__tests__/oauth.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple OAuth-related tests (details truncated)

---

## 5. `src/__tests__/setup.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple setup-related tests (details truncated)

---

## 6. `src/lib/__tests__/connectivity-scheduler.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple connectivity scheduler tests (details truncated)

---

## 7. `src/routes/__tests__/azure-settings.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple Azure settings API tests (details truncated)

---

## 8. `src/routes/__tests__/containers.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple container API tests (details truncated)

---

## 9. `src/routes/__tests__/postgres-backup-configs.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple PostgreSQL backup config API tests (details truncated)

---

## 10. `src/routes/__tests__/postgres-backups.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple PostgreSQL backup API tests (details truncated)

---

## 11. `src/routes/__tests__/postgres-databases.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple PostgreSQL database API tests (details truncated)

---

## 12. `src/routes/__tests__/postgres-progress.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple PostgreSQL progress API tests (details truncated)

---

## 13. `src/routes/__tests__/postgres-restore.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple PostgreSQL restore API tests (details truncated)

---

## 14. `src/routes/__tests__/settings.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple settings API tests (details truncated)

---

## 15. `src/services/__tests__/azure-config.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple Azure configuration service tests (details truncated)

---

## 16. `src/services/__tests__/backup-config.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple backup configuration service tests (details truncated)

---

## 17. `src/services/__tests__/backup-executor.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple backup executor service tests (details truncated)

---

## 18. `src/services/__tests__/backup-scheduler.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple backup scheduler service tests (details truncated)

---

## 19. `src/services/__tests__/cloudflare-config.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple Cloudflare configuration service tests (details truncated)

---

## 20. `src/services/__tests__/configuration-base.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple configuration base service tests (details truncated)

---

## 21. `src/services/__tests__/configuration-factory.test.ts`

### Issues:
- **Incorrect factory type handling** - Factory with corrupted supported categories test failing

### Failed Tests:
- Multiple configuration factory tests (details truncated)

---

## 22. `src/services/__tests__/progress-tracker.test.ts`

### Issues:
- **Invalid time value error** - `RangeError: Invalid time value at ClockDate.toISOString`
- **Timeout errors** - Tests exceeding 5000ms timeout
- **Periodic cleanup tests failing**

### Failed Tests:
1. `ProgressTrackerService › getOperationHistory › should apply pagination`
2. `ProgressTrackerService › periodic cleanup › should execute cleanup periodically`
3. `ProgressTrackerService › periodic cleanup › should handle periodic cleanup errors gracefully`

---

## Priority Order for Fixing

### High Priority (Core Infrastructure):
1. **Docker Service Tests** - Core container management functionality
2. **API Key Service** - Security/authentication issues
3. **Progress Tracker** - Date/time handling issues

### Medium Priority (Configuration Services):
4. **Azure Config Tests**
5. **Cloudflare Config Tests**
6. **Backup Configuration Tests**

### Lower Priority (API Routes):
7. **Settings API Tests**
8. **Container API Tests**
9. **PostgreSQL API Tests**

---

## Notes:
- Many test outputs were truncated due to character limits
- Consider running individual test files to get complete error details
- Some issues may be related to environment setup (Docker connection, test database, etc.)
- Date/time handling in progress tracker needs investigation
- API key hashing logic needs review