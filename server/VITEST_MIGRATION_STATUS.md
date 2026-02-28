# Vitest Migration Status

Migration from Jest 30 + ts-jest to Vitest 4.

## Current Results

- **Test Files**: 49/49 passing
- **Individual Tests**: 1241/1242 passing (1 skipped)

## Migration Complete

All test files now pass successfully.

## What Was Done

1. **Infrastructure**: Replaced jest.config.js with vitest.config.ts, updated package.json scripts, tsconfig.json types
2. **Dependencies**: Removed jest/ts-jest/@types/jest, added vitest
3. **Bulk replacements**: jest.mock → vi.mock, jest.fn → vi.fn, jest.spyOn → vi.spyOn, timer functions, type utilities, removed __esModule markers
4. **vi.hoisted()**: Applied to ~35 files where mock variables are referenced inside vi.mock() factories
5. **Constructor mocks**: Changed arrow functions to regular functions for Vitest 4 compatibility
6. **Default export wrapping**: Added `{ default: ... }` to vi.mock() for modules with default exports (prisma, dockerode, node-cache, passport, etc.)
7. **Test assertion updates**: Updated test expectations to match current source code signatures (removed stale userId parameters, updated API URLs, etc.)
8. **vi.doMock → vi.mock**: Replaced vi.doMock (which only works with dynamic imports) with vi.mock + vi.hoisted() for static import mocking (environment-api)
9. **Proxy-based prisma mock**: Used Proxy pattern for prisma mock in registry-credentials-api to defer access until testPrisma is initialized in beforeAll
10. **Mock data updates**: Added missing fields to mock objects (containers arrays for deployment status/history, hAProxyFrontend model for deployment delete)
11. **Source code alignment**: Updated test assertions to match current route signatures (userId parameters, deleteEnvironment options object, etc.)
