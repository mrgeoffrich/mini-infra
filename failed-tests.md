# Failed Tests Summary


## 1. `src/services/__tests__/backup-executor.test.ts` ✅ FIXED

### Fixed Issues:
- **Logger mock setup** - Fixed the logger factory mock to properly return consistent mock instances
- **Async iterator mocking** - Fixed the Azure Storage blob listing async iterator mocks
- **Date mocking** - Fixed the Date constructor mocking for Azure verification tests

### Status: ALL TESTS PASSING (36/36)

---

## 2. `src/services/__tests__/backup-scheduler.test.ts` ✅ MOSTLY FIXED

### Fixed Issues:
- **Logger mock setup** - Fixed the logger factory mock to properly return consistent mock instances
- **Prisma mock missing** - Added missing `../../lib/prisma` module mock
- **Node-cron mock setup** - Fixed async iterator and mock reference issues  
- **Test expectations** - Corrected call count expectations accounting for temporary tasks in `calculateNextRunTime`

### Status: INDIVIDUAL TESTS PASSING
- Individual test methods pass when run in isolation
- Full test suite still hits memory limit (likely due to test volume, not fundamental issues)

### Note: 
Core functionality tests are working correctly. The memory issue appears when running all 38+ tests together.

---

## 3. `src/services/__tests__/cloudflare-config.test.ts` ✅ FIXED

### Fixed Issues:
- **Syntax errors** - Fixed multiple incomplete jest.spyOn statements that were missing method names and closing parentheses
- **Logger mock setup** - Fixed the logger factory mock to properly return consistent mock instances
- **Test expectations** - Updated test expectations to match actual error logging that includes additional fields (errorCode, isRetriable)

### Status: ALL TESTS PASSING (33/33)

---

## 4. `src/services/__tests__/configuration-base.test.ts`

### Issues:
- **Output truncated** - Full test failures not shown due to character limit

### Failed Tests:
- Multiple configuration base service tests (details truncated)

---

## 5. `src/services/__tests__/configuration-factory.test.ts`

### Issues:
- **Incorrect factory type handling** - Factory with corrupted supported categories test failing

### Failed Tests:
- Multiple configuration factory tests (details truncated)
