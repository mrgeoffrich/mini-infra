const js = require("@eslint/js");
const globals = require("globals");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config([
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**", "src/generated/**"],
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["src/**/*.test.ts", "src/**/__tests__/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
        afterAll: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        describe: "readonly",
        expect: "readonly",
        it: "readonly",
        test: "readonly",
        vi: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-unexpected-multiline": "off",
    },
  },
  {
    files: ["src/**/*.integration.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../lib/prisma",
              message:
                "Use integration-test-helpers/testPrisma or injected dependencies instead of the shared app Prisma client.",
            },
            {
              name: "../lib/prisma.ts",
              message:
                "Use integration-test-helpers/testPrisma or injected dependencies instead of the shared app Prisma client.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='PrismaClient']",
          message:
            "Do not construct PrismaClient inside integration tests. Use integration-test-helpers.ts instead.",
        },
        {
          selector:
            "CallExpression[callee.object.name='test'][callee.property.name='concurrent']",
          message:
            "DB-backed integration tests must not use test.concurrent. Use worker-level parallelism instead.",
        },
        {
          selector:
            "CallExpression[callee.object.name='it'][callee.property.name='concurrent']",
          message:
            "DB-backed integration tests must not use it.concurrent. Use worker-level parallelism instead.",
        },
        {
          selector: "CallExpression[callee.property.name='deleteMany']",
          message:
            "Do not manually clean tables in integration tests. The integration harness already truncates the worker database.",
        },
      ],
    },
  },
  // Phase 11 — error-handling conventions (see docs/planning/not-shipped/
  // error-handling-overhaul-plan.md). Services must not throw a raw `new
  // Error`: use a taxonomy error from `src/lib/errors.ts` for a user-actionable
  // failure, or `new InternalError(...)` for a genuine internal invariant.
  {
    files: ["src/services/**/*.ts"],
    ignores: ["src/services/**/*.test.ts", "src/services/**/__tests__/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ThrowStatement > NewExpression[callee.name='Error']",
          message:
            "Do not throw a raw `new Error` in services. Throw a taxonomy error from '../lib/errors' (ConflictError/NotFoundError/ValidationError/UnauthorizedError/ForbiddenError) for a user-actionable failure, or `new InternalError(...)` for a genuine internal invariant that should stay a 500.",
        },
      ],
    },
  },
  // Routes must not derive HTTP status by string-matching an error message —
  // throw a taxonomy error from the service and let the central middleware map it.
  {
    files: ["src/routes/**/*.ts"],
    ignores: ["src/routes/**/*.test.ts", "src/routes/**/__tests__/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='includes'][callee.object.property.name='message']",
          message:
            "Do not derive HTTP status by string-matching an error message (`err.message.includes(...)`). Throw a taxonomy error from the service and let the central error middleware map the status.",
        },
      ],
    },
  },
]);
