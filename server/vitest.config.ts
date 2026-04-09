import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          setupFiles: ["./src/__tests__/setup-unit.ts"],
          pool: "forks",
          maxForks: "50%",
          testTimeout: 5000,
          include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
          exclude: ["src/**/__tests__/**/*.integration.test.ts"],
          coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.d.ts", "src/generated/**"],
          },
        },
      },
      {
        test: {
          name: "integration",
          globals: true,
          environment: "node",
          // DB-backed integration tests run in parallel because each worker
          // gets its own cloned SQLite database in setup-integration.ts.
          setupFiles: ["./src/__tests__/setup-integration.ts"],
          pool: "forks",
          maxForks: "50%",
          testTimeout: 10000,
          include: ["src/**/__tests__/**/*.integration.test.ts"],
          exclude: ["src/**/__tests__/haproxy-dataplane-client.integration.test.ts"],
          coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.d.ts", "src/generated/**"],
          },
        },
      },
      {
        test: {
          name: "external-integration",
          globals: true,
          environment: "node",
          // These tests touch process-wide singletons and external resources,
          // so keep them isolated from the parallel DB integration project.
          setupFiles: ["./src/__tests__/setup-integration.ts"],
          pool: "forks",
          maxForks: 1,
          fileParallelism: false,
          testTimeout: 30000,
          include: ["src/**/__tests__/haproxy-dataplane-client.integration.test.ts"],
          coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.d.ts", "src/generated/**"],
          },
        },
      },
    ],
  },
});
