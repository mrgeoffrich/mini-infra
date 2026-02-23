# Refactoring Large Service Classes

A guide for splitting a large single-file service class into focused modules without breaking consumers or tests.

## When to Use This

You have a service file that has grown beyond ~500 lines and contains multiple distinct responsibility groups (e.g., CRUD for different resources, client setup, monitoring, authentication). It's imported widely and has existing tests.

## Strategy: Facade + Composition

Replace the file with a directory of the same name. A facade class in `index.ts` preserves the original public API and delegates to focused sub-modules. **Zero consumer files need changes.**

Node resolves `import { X } from "./my-service"` to `./my-service/index.ts` when you replace a file with a directory of the same name.

### Typical Layout

```
my-service/
├── index.ts           # Facade class + re-exports
├── types.ts           # Shared interfaces
├── utils.ts           # Pure helper functions
├── client-factory.ts  # Client/connection setup
├── reader.ts          # Read operations
├── writer.ts          # Write/mutation operations
└── ...                # One file per responsibility group
```

## Key Patterns

### 1. Sub-modules receive dependencies via constructor

Each module takes its dependencies as constructor arguments. No sub-module creates shared resources — the facade owns that lifecycle.

```typescript
export class Reader {
  private client: SomeClient;

  constructor(client: SomeClient) {
    this.client = client;
  }

  public async getById(id: string) {
    return this.client.query(id);
  }
}
```

### 2. Facade delegates every public method

The facade has the same method signatures as the original class. Each method is a one-liner forwarding to the appropriate sub-module.

```typescript
export class MyService {
  private reader!: Reader;

  public async getById(id: string) {
    return this.reader.getById(id);
  }
}
```

### 3. Getter/setter rebuilds sub-modules when a shared dependency changes

Tests often set internal properties directly: `(service as any).client = mock`. If sub-modules store their own reference to that dependency, the test's assignment won't propagate. A setter intercepts the assignment and rebuilds sub-modules.

```typescript
private _client: SomeClient;

private get client(): SomeClient {
  return this._client;
}

private set client(value: SomeClient) {
  this._client = value;
  this.rebuildSubModules();
}

private rebuildSubModules(): void {
  this.reader = new Reader(this._client);
  this.writer = new Writer(this._client);
}
```

This is the most important compatibility detail when tests bypass `initialize()` by setting properties directly.

### 4. Keep spied-on private methods on the facade

Tests that spy on private methods (`jest.spyOn(service as any, "someHelper")`) need that method to exist on the facade instance. Keep a thin forwarding method rather than removing it entirely.

```typescript
private someHelper(arg: string): string {
  return this.factory.someHelper(arg);
}
```

### 5. Types in their own file, re-exported from the barrel

```typescript
// types.ts
export interface MyOptions { /* ... */ }
export interface MyResult { /* ... */ }

// index.ts
export type { MyOptions, MyResult } from "./types";
```

### 6. Stateless helpers are free functions, not classes

If a function has no state and just transforms its arguments, export it as a standalone function from `utils.ts`.

```typescript
export function categorize(options: MyOptions): string {
  if (options.name.includes("backup")) return "backup";
  return "general";
}
```

## Before You Start

### Audit consumers

Find every file that imports from the module you're splitting:

```bash
grep -r 'from.*my-service' --include="*.ts" src/
```

Note which exports each consumer uses (class, types, or both). The facade must re-export all of them.

### Audit test mocks

Find every test that mocks the module:

```bash
grep -r 'jest.mock.*my-service' --include="*.test.ts" src/
```

Pay attention to:
- **Auto-mocks** (`jest.mock("../my-service")`) — these need the module to resolve correctly
- **Property assignments** (`(service as any).prop = mock`) — these need the getter/setter pattern
- **Spy targets** (`jest.spyOn(service as any, "method")`) — these need forwarding methods on the facade

### Baseline the tests

Capture the current pass/fail state so you can diff against it later:

```bash
cd server && npm test 2>&1 | grep '^FAIL' | sort > /tmp/before.txt
```

## Implementation Order

1. **Create the directory and `types.ts`** — move exported interfaces
2. **Create `utils.ts`** — move pure functions
3. **Create sub-module files** — one per responsibility group, each with a class that takes dependencies via constructor
4. **Create `index.ts`** — facade class with getter/setter, re-exports
5. **Delete the old file** — the directory takes its place
6. **Build first** (`npm run build`) — fix type errors before worrying about tests
7. **Run tests and diff** — compare against your baseline

```bash
npm test 2>&1 | grep '^FAIL' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

## Gotchas

**Circular imports.** If module A imports from B and B imports from A, this works as long as the usage is lazy (inside a method body, not at module load time). After refactoring, verify the import chain hasn't changed the load order. A `TypeError: X is not a function` at module load time is the telltale sign.

**File-to-directory swap.** A file `my-service.ts` and a directory `my-service/` cannot coexist. Delete the file after creating the directory.

**Test mock scope.** `jest.mock("../my-service")` mocks the module at its resolved absolute path. Sub-modules that import shared dependencies (like a logger) from a different relative path still resolve to the same absolute path, so existing mocks apply. If a test suite fails to run after refactoring, check whether a new transitive import introduced a dependency that the test doesn't mock.

**Don't refactor and change behavior in the same PR.** The facade should produce identical behavior. Improving the sub-modules (better error handling, new features) is a separate step.
