import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { globalIgnores } from "eslint/config";

export default tseslint.config([
  globalIgnores(["dist"]),
  {
    files: ["src/__tests__/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/__tests__/**"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: "./tsconfig.app.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          allowExportNames: [
            "buttonVariants",
            "badgeVariants",
            "toggleVariants",
            "sidebarMenuButtonVariants",
            "schema",
            "useFormField",
            "useSidebar",
          ],
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      // ====================
      // Frontend/backend contract guard (Phase 4 of
      // docs/planning/not-shipped/frontend-backend-contract-plan.md).
      // Blocking (error-level): the three primitives below (apiFetch,
      // ApiRoute, queryKeys) are the only sanctioned way to talk to the API
      // from client/src. Exemptions live in the override block further down
      // (client/src/lib/api-client.ts itself, and test files).
      // ====================
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "Raw fetch() is banned in client/src — use apiFetch() from '@/lib/api-client' instead (see client/src/hooks/useContainers.ts for the reference pattern).",
        },
        {
          selector: "Literal[value=/^\\/(api|auth)(\\/|$)/]",
          message:
            "Hardcoded '/api' or '/auth' path literals are banned in client/src — use an ApiRoute.* builder from '@mini-infra/types' instead.",
        },
        {
          selector: "TemplateElement[value.raw=/^\\/(api|auth)(\\/|$)/]",
          message:
            "Hardcoded '/api' or '/auth' path literals are banned in client/src — use an ApiRoute.* builder from '@mini-infra/types' instead.",
        },
        {
          // Flags a `queryKey` array that contains at least one *literal*
          // element directly (e.g. `["stacks", id]`) — i.e. someone typed a
          // raw resource-name string inline. Deliberately does NOT flag
          // composing from the registry, e.g. `[...queryKeys.tls.certificates]`
          // or `[...queryKeys.x.y, extraId]` (no direct Literal child), which
          // is the sanctioned pattern for call sites that need one shared
          // key spread into a fresh array (task-type-registry.ts, etc).
          selector: "Property[key.name='queryKey'] > ArrayExpression:has(> Literal)",
          message:
            "Inline queryKey array literals are banned in client/src — use a queryKeys.* builder from '@mini-infra/types' instead.",
        },
        {
          // Phase 11 (error-handling overhaul): a `toast.error(...)` that
          // surfaces a raw `error.message` is a bare, non-actionable server
          // sentence. Route caught errors through `toastApiError(err, { title })`
          // / `getUserFacingError` from '@/lib/errors'; mutation errors already
          // toast by default via the global MutationCache.onError.
          selector:
            "CallExpression[callee.object.name='toast'][callee.property.name='error'] MemberExpression[property.name='message']",
          message:
            "Do not surface a raw `error.message` in a toast. Use `toastApiError(err, { title })` from '@/lib/errors' (or getUserFacingError for inline errors); mutation errors already toast via the global MutationCache.onError.",
        },
      ],
    },
  },
  {
    // Exemptions for the guard rules above: the shared HTTP client itself
    // (which legitimately calls the real fetch()) and test files (per the
    // Phase 4 plan — __tests__/** is already excluded from the main block
    // above via `ignores`, but this also covers co-located *.test.ts(x)
    // files living outside __tests__/).
    files: ["src/lib/api-client.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    files: ["*.config.{ts,js}", "*.config.*.{ts,js}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
