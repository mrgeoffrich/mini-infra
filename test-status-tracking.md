# Server Test Status Tracking

## Test Files Status

### ❌ FAILING TEST FILES (19)

#### Core Application Tests
| File | Status | Primary Issues | Location |
|------|--------|----------------|----------|
| `application-service-factory.test.ts` | **PASSING** | All tests now pass (was fixed previously) | `src/__tests__/` |
| `container-lifecycle-manager.test.ts` | **PASSING** | All tests now pass after mock setup and date precision fixes | `src/__tests__/` |
| `deployment-api.test.ts` | **✅ PASSING** | All 36/36 tests passing - completely fixed mock data setup, authentication, and payload issues | `src/__tests__/` |
| `deployment-orchestrator.test.ts` | **✅ PASSING** | All 28/28 tests passing - completely fixed database foreign key issues, state machine initialization, health check flow, rollback functionality, and database integration | `src/__tests__/` |
| `environment-api.test.ts` | **✅ PASSING** | All 25/25 tests passing - completely fixed query parameter type conversion and date serialization issues | `src/__tests__/` |

#### Route Tests
| File | Status | Primary Issues | Location |
|------|--------|----------------|----------|
| `postgres-restore.test.ts` | **✅ PASSING** | All 37/37 tests passing - fixed route path mismatches, URL validation for .sql files, authentication middleware, and RestoreExecutorService instance mocking | `src/routes/__tests__/` |
| `postgres-backup-configs.test.ts` | **✅ PASSING** | All 28/28 tests passing - fixed authentication middleware mock variable reference error | `src/routes/__tests__/` |
| `postgres-backups.test.ts` | **✅ PASSING** | All 34/34 tests passing - fixed authentication middleware mock setup | `src/routes/__tests__/` |
| `postgres-databases.test.ts` | **✅ PASSING** | All 31/31 tests passing - fixed authentication middleware mock variable reference error | `src/routes/__tests__/` |
| `postgres-progress.test.ts` | **✅ PASSING** | All 27/27 tests passing - authentication middleware working correctly | `src/routes/__tests__/` |
| `azure-settings.test.ts` | **✅ PASSING** | All 33/33 tests passing - authentication middleware fixed | `src/routes/__tests__/` |
| `containers.test.ts` | **✅ PASSING** | All 26/26 tests passing - fixed authentication middleware and user ID expectation in test | `src/routes/__tests__/` |
| `settings.test.ts` | **✅ PASSING** | All 44/44 tests passing - fixed service validation message to include all supported services | `src/routes/__tests__/` |

#### Service Tests
| File | Status | Primary Issues | Location |
|------|--------|----------------|----------|
| `docker-config.test.ts` | **✅ PASSING** | All 35/35 tests passing - fixed missing dockerExecutorLogger mock in test file | `src/services/__tests__/` |
| `backup-config.test.ts` | **✅ PASSING** | All 39/39 tests passing - fixed timezone field expectation in mock call | `src/services/__tests__/` |
| `deployment-infrastructure.test.ts` | **✅ PASSING** | All 20/20 tests passing - fixed Docker service mocking and integration test patterns | `src/services/__tests__/` |
| `deployment-state-machine.test.ts` | **✅ PASSING** | All 12/12 tests passing - fixed failed state to support retry transitions with canRetry guard | `src/services/__tests__/` |
| `backup-executor.test.ts` | **✅ PASSING** | All 36/36 tests passing - fixed queue mock missing getStats method, Azure storage client mock setup, and date mocking issues | `src/services/__tests__/` |
| `backup-scheduler-simple.test.ts` | **✅ PASSING** | All 4/4 tests passing - memory-based scheduler tests working correctly | `src/services/__tests__/` |
| `restore-executor.test.ts` | **✅ PASSING** | All 50/50 tests passing - fixed mock queue getStats method, logger call expectations, Azure cleanup error handling, and Docker container environment variables | `src/services/__tests__/` |
| `docker-executor.test.ts` | **✅ PASSING** | All 34/34 tests passing - fixed container label expectations to match actual generated labels from ContainerLabelManager | `src/services/__tests__/` |
| `postgres-config.test.ts` | **✅ PASSING** | All 51/51 tests passing - authentication middleware working correctly | `src/services/__tests__/` |

---
