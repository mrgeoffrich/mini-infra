# Vitest Migration Status

Migration from Jest 30 + ts-jest to Vitest 4.

## Current Results

- **Test Files**: 42/49 passing
- **Individual Tests**: 1187/1242 passing (1 skipped)

## Remaining Failures (7 files)

| File | Failed | Passed | Total |
|------|--------|--------|-------|
| `src/__tests__/deployment-api.test.ts` | 6 | 29 | 35 |
| `src/__tests__/environment-api.test.ts` | 30 | 2 | 32 |
| `src/__tests__/registry-credentials-api.test.ts` | 13 | 3 | 16 |
| `src/__tests__/services/tls/acme-client-manager.test.ts` | 1 | 8 | 9 |
| `src/services/__tests__/configuration-factory.test.ts` | 2 | 24 | 26 |
| `src/services/__tests__/restore-executor.test.ts` | 1 | 49 | 50 |

## What Was Done

1. **Infrastructure**: Replaced jest.config.js with vitest.config.ts, updated package.json scripts, tsconfig.json types
2. **Dependencies**: Removed jest/ts-jest/@types/jest, added vitest
3. **Bulk replacements**: jest.mock → vi.mock, jest.fn → vi.fn, jest.spyOn → vi.spyOn, timer functions, type utilities, removed __esModule markers
4. **vi.hoisted()**: Applied to ~35 files where mock variables are referenced inside vi.mock() factories
5. **Constructor mocks**: Changed arrow functions to regular functions for Vitest 4 compatibility
6. **Default export wrapping**: Added `{ default: ... }` to vi.mock() for modules with default exports (prisma, dockerode, node-cache, passport, etc.)
7. **Test assertion updates**: Updated test expectations to match current source code signatures (removed stale userId parameters, updated API URLs, etc.)
