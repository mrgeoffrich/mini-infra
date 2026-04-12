import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { globalIgnores } from "eslint/config";

export default tseslint.config([
  globalIgnores(["dist"]),
  {
    files: ["src/**/*.{ts,tsx}"],
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
      // typescript-eslint 8.58 changed these from warn/absent to error in recommended.
      // Restore to pre-upgrade severity.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      // ESLint 10 new rule — too many pre-existing violations to fix in the upgrade PR.
      // TODO: fix in a follow-up cleanup PR.
      "preserve-caught-error": "off",
      // react-hooks v7 new rules (activated by switching to flat config format).
      // These were not enforced before because the plugin used the legacy config format.
      // TODO: fix in a follow-up cleanup PR.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
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
