/**
 * Phase 10 of the frontend/backend contract migration
 * (docs/planning/not-shipped/frontend-backend-contract-plan.md): guards the
 * `Permission` const map added to `@mini-infra/types` (mirroring the
 * `Channel`/`ServerEvent` idiom in `lib/types/socket-events.ts`) and the
 * server-wide sweep off raw `"resource:action"` scope-string literals onto
 * `Permission.*`.
 *
 * The plan calls for an ESLint rule to enforce "no raw permission-scope
 * literal in a permission-check call site" going forward, but this repo's
 * SERVER ESLint is independently broken (ajv hoisting — see
 * `docs/planning/not-shipped/frontend-backend-contract-plan.md` and
 * `pnpm --filter mini-infra-server lint`, which crashes at startup before
 * linting a single file). This test is the enforceable substitute: it scans
 * the live `server/src` tree (mirroring the `api-routes-drift.test.ts`
 * pattern of asserting against real source rather than a frozen snapshot)
 * and fails if a *known* permission scope (from `ALL_PERMISSION_SCOPES`)
 * ever reappears as a raw quoted literal in one of the call shapes that
 * gate access:
 *
 *   - requirePermission("scope") / requirePermission('scope')
 *   - requirePoolAccess("scope")            (stacks-pool-routes.ts's local wrapper)
 *   - callerHasScope(req, "scope")          (stack-templates.ts's local helper)
 *   - hasPermission(permissions, "scope")   (direct catalog helper calls)
 *   - permission: "scope"                  (describeRoute() meta, e.g. containers.ts/diagnostics.ts)
 *   - requiredPermissions: ["scope"]        (403 response body echoing the required scope)
 *
 * If this test fails, replace the flagged literal with `Permission.Xyz`
 * (see `lib/types/permissions.ts`) — do NOT add the literal to an allowlist;
 * a raw scope string here is exactly the magic-string regression this test
 * exists to catch.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { Permission, ALL_PERMISSION_SCOPES } from "@mini-infra/types";

const SERVER_SRC_DIR = path.resolve(__dirname, "..");

/** Directory names never walked (generated code, fixtures, this test itself). */
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "generated", "__tests__"]);

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkTsFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(path.join(dir, entry.name));
    }
  }
}

/** Escape a literal string for embedding inside a RegExp character run. */
function escapeForRegExp(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// Longest-first so e.g. "vault:write" can't shadow a longer scope that
// happens to share a prefix (defensive; no current scope is a strict
// prefix of another, but this keeps the alternation order-independent).
const scopeAlternation = [...ALL_PERMISSION_SCOPES]
  .sort((a, b) => b.length - a.length)
  .map(escapeForRegExp)
  .join("|");

/**
 * One regex per permission-check call shape the Phase 10 sweep covers.
 * Each captures the quoted scope literal; a match means a live scope string
 * slipped through (or was reintroduced) as a raw literal instead of
 * `Permission.*`.
 */
const CALL_SITE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "requirePermission(...)", re: new RegExp(`requirePermission\\(\\s*(["'])(?:${scopeAlternation})\\1`, "g") },
  { label: "requirePoolAccess(...)", re: new RegExp(`requirePoolAccess\\(\\s*(["'])(?:${scopeAlternation})\\1`, "g") },
  { label: "callerHasScope(...)", re: new RegExp(`callerHasScope\\([^,]+,\\s*(["'])(?:${scopeAlternation})\\1`, "g") },
  { label: "hasPermission(...)", re: new RegExp(`hasPermission\\([^,]+,\\s*(["'])(?:${scopeAlternation})\\1`, "g") },
  { label: "describeRoute() permission meta", re: new RegExp(`permission:\\s*(["'])(?:${scopeAlternation})\\1\\s*,`, "g") },
  { label: "requiredPermissions response array", re: new RegExp(`requiredPermissions:\\s*\\[(["'])(?:${scopeAlternation})\\1\\]`, "g") },
];

function findRawScopeLiterals(): string[] {
  const files: string[] = [];
  walkTsFiles(SERVER_SRC_DIR, files);

  const hits: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (const { label, re } of CALL_SITE_PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const upToMatch = content.slice(0, match.index);
        const lineNumber = upToMatch.split("\n").length;
        const relPath = path.relative(SERVER_SRC_DIR, file);
        hits.push(`${relPath}:${lineNumber} [${label}] ${lines[lineNumber - 1]?.trim()}`);
      }
    }
  }
  return hits;
}

describe("Permission map (Phase 10)", () => {
  it("has a non-empty Permission map (sanity check on the harness itself)", () => {
    expect(Object.keys(Permission).length).toBeGreaterThan(0);
  });

  it("Permission values exactly equal ALL_PERMISSION_SCOPES — no missing scope, no stale/extra value, no duplicate", () => {
    const mapValues = Object.values(Permission);
    const mapSet = new Set(mapValues);
    const catalogSet = new Set(ALL_PERMISSION_SCOPES);

    expect(mapValues.length, "Permission map has duplicate scope values").toBe(mapSet.size);

    const missingFromMap = ALL_PERMISSION_SCOPES.filter((s) => !mapSet.has(s));
    const staleInMap = mapValues.filter((s) => !catalogSet.has(s));

    expect(
      missingFromMap,
      `Scopes in ALL_PERMISSION_SCOPES but missing a Permission.* constant: ${missingFromMap.join(", ")}`,
    ).toEqual([]);
    expect(
      staleInMap,
      `Permission.* values that are no longer real scopes in ALL_PERMISSION_SCOPES: ${staleInMap.join(", ")}`,
    ).toEqual([]);
  });
});

describe("No raw permission-scope string literals in server/src (Phase 10 sweep guard)", () => {
  it("walks a non-trivial number of source files (sanity check on the harness itself)", () => {
    const files: string[] = [];
    walkTsFiles(SERVER_SRC_DIR, files);
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no requirePermission(...)/describeRoute()/hasPermission(...)/callerHasScope(...)/requirePoolAccess(...) call site using a raw scope literal instead of Permission.*", () => {
    const hits = findRawScopeLiterals();

    if (hits.length > 0) {
      throw new Error(
        `${hits.length} raw permission-scope string literal(s) found in server/src permission-check call sites. ` +
          `Replace each with the matching Permission.* constant from lib/types/permissions.ts:\n  ${hits.join("\n  ")}`,
      );
    }

    expect(hits).toEqual([]);
  });
});
