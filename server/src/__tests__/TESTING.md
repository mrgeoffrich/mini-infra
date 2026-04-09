# Server Testing Guide

## Test Projects

- `unit`: fast, parallel tests with no database dependency
- `integration`: database-backed tests running in parallel with one SQLite file per Vitest worker
- `external-integration`: serialized tests for process-wide singletons, Docker, sockets, or other external resources

## DB-backed Test Rules

- Use `integration-test-helpers.ts` for `testPrisma`, `createTestUser`, and shared DB lifecycle
- Do not construct `new PrismaClient()` inside integration test files
- Do not call `deleteMany()` or manually truncate tables in integration tests
- Do not use `test.concurrent` or `it.concurrent` in DB-backed integration tests
- Prefer `test-data-factories.ts` for payloads with unique business keys

## Route Test Pattern

- Prefer `createApp` from `app-factory.ts` with `includeRouteIds` and `routeOverrides` over loading the full app and mocking module-level singletons
- For DB-backed route tests, inject the service instance that uses `testPrisma`

## External Integration Tests

- Keep Docker, HAProxy, timers, and singleton-heavy tests in `external-integration`
- These tests must clean up any external resources they create, but should still avoid database-wide cleanup because the harness already owns DB truncation
