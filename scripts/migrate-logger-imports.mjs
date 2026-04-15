#!/usr/bin/env node
// One-shot migration script for server logging consolidation.
// Rewrites imports from legacy xxxLogger() factories to getLogger(component, subcomponent).
// Usage: node scripts/migrate-logger-imports.mjs [--dry-run]

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("server/src");
const DRY = process.argv.includes("--dry-run");

// Files that must NOT be rewritten (startup code, scripts, tests, infra itself).
const EXCLUDE_ABS = new Set(
  [
    "lib/logger-factory.ts",
    "lib/logging-config.ts",
    "lib/logging-context.ts",
    "lib/request-id.ts",
  ].map((p) => path.join(ROOT, p)),
);

const EXCLUDE_PREFIXES = ["__tests__/", "scripts/"];

function isExcluded(absPath) {
  if (EXCLUDE_ABS.has(absPath)) return true;
  const rel = path.relative(ROOT, absPath).replace(/\\/g, "/");
  if (rel.includes("__tests__/") || rel.includes("/__tests__/")) return true;
  if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) return true;
  return false;
}

// Map of path-glob-style rules → component.
// Evaluated top to bottom; first match wins. Use startsWith on the repo-relative
// path under server/src.
const RULES = [
  // TLS
  ["services/tls/", "tls"],

  // Deploy-oriented HAProxy pieces
  ["services/haproxy/blue-green-", "deploy"],
  ["services/haproxy/actions/deploy-", "deploy"],
  ["services/haproxy/actions/monitor-container", "deploy"],
  ["services/haproxy/actions/enable-traffic", "deploy"],
  ["services/haproxy/actions/disable-traffic", "deploy"],
  ["services/haproxy/actions/remove-application", "deploy"],
  ["services/haproxy/actions/stop-application", "deploy"],
  ["services/haproxy/actions/log-deployment", "deploy"],
  ["services/haproxy/actions/alert-operations", "deploy"],
  ["services/haproxy/actions/perform-health-checks", "deploy"],
  ["services/haproxy/actions/validate-traffic", "deploy"],
  ["services/haproxy/actions/initiate-drain", "deploy"],
  ["services/haproxy/actions/monitor-drain", "deploy"],
  ["services/haproxy/actions/cleanup-temp", "deploy"],
  // Remaining HAProxy primitives
  ["services/haproxy/", "haproxy"],

  // Backup / restore
  ["services/backup/", "backup"],
  ["services/restore-executor/", "backup"],
  ["services/progress-tracker.ts", "backup"],

  // Stacks / environment
  ["services/stacks/", "stacks"],
  ["services/environment/", "stacks"],

  // Docker
  ["services/docker.ts", "docker"],
  ["services/docker-executor/", "docker"],
  ["services/container/", "docker"],
  ["services/container-", "docker"],
  ["services/image-inspect.ts", "docker"],
  ["services/registry-credential.ts", "docker"],
  ["services/volume/", "docker"],
  ["services/network-utils.ts", "docker"],
  ["lib/docker-event-pattern-detector.ts", "docker"],

  // Integrations
  ["services/cloudflare/", "integrations"],
  ["services/github-service.ts", "integrations"],
  ["services/github-app/", "integrations"],

  // Agent
  ["services/agent", "agent"],
  ["routes/agent", "agent"],

  // Auth
  ["lib/jwt", "auth"],
  ["lib/auth-", "auth"],
  ["lib/auth-middleware.ts", "auth"],
  ["lib/auth-settings-service.ts", "auth"],
  ["lib/api-key", "auth"],
  ["lib/passport.ts", "auth"],
  ["lib/permission", "auth"],
  ["lib/account-lockout", "auth"],
  ["lib/password-service.ts", "auth"],
  ["services/dev-api-key.ts", "auth"],
  ["services/agent-api-key.ts", "auth"],
  ["services/permission-preset-service.ts", "auth"],
  ["routes/auth", "auth"],
  ["routes/api-keys.ts", "auth"],
  ["routes/permission-presets.ts", "auth"],
  ["routes/users.ts", "auth"],

  // DB
  ["lib/prisma.ts", "db"],
  ["services/postgres/", "db"],
  ["services/postgres-server/", "db"],
  ["routes/postgres-server/", "db"],

  // Backup-flavoured postgres routes (override the general postgres→db rule above;
  // these are listed BEFORE the general postgres rule would have matched, but
  // since we match in order, we need to place them BEFORE services/postgres/*)
  ["routes/postgres-backups.ts", "backup"],
  ["routes/postgres-restore.ts", "backup"],
  ["routes/postgres-progress.ts", "backup"],
  ["routes/postgres-databases.ts", "db"],
  ["routes/postgres-backup-configs.ts", "backup"],

  // Platform grab-bag
  ["services/monitoring/", "platform"],
  ["services/health-check", "platform"],
  ["services/circuit-breaker", "platform"],
  ["services/connectivity", "platform"],
  ["services/dns/", "platform"],
  ["services/self-update.ts", "platform"],
  ["services/application-service-factory.ts", "platform"],
  ["services/user-events/", "platform"],
  ["services/user-preferences.ts", "platform"],
  ["services/configuration-base.ts", "platform"],
  ["services/configuration-factory.ts", "platform"],
  ["services/docker-config.ts", "platform"],
  ["services/restore-executor-instance", "backup"],
  ["lib/connectivity-scheduler.ts", "platform"],
  ["lib/socket.ts", "platform"],
  ["lib/security-config.ts", "platform"],
  ["lib/error-handler.ts", "platform"],
  ["lib/public-url-service.ts", "platform"],
  ["lib/api-logger.ts", "platform"],
  ["lib/in-memory-queue.ts", "platform"],
  ["lib/security.ts", "platform"],

  // Diagnostics / monitoring / self-update routes
  ["routes/diagnostics.ts", "platform"],
  ["routes/self-update.ts", "platform"],
  ["routes/monitoring.ts", "platform"],
  ["routes/events.ts", "platform"],

  // TLS routes
  ["routes/tls-", "tls"],

  // Cloudflare routes
  ["routes/cloudflare", "integrations"],
  ["routes/registry-credentials.ts", "docker"],

  // DNS routes
  ["routes/dns.ts", "platform"],

  // Stack routes
  ["routes/stacks/", "stacks"],
  ["routes/stack-templates.ts", "stacks"],
  ["routes/environments.ts", "stacks"],
  ["routes/environment-networks.ts", "stacks"],

  // Images / containers / docker routes
  ["routes/images.ts", "docker"],
  ["routes/containers.ts", "docker"],
  ["routes/docker.ts", "docker"],

  // HAProxy routes
  ["routes/haproxy", "haproxy"],
  ["routes/manual-haproxy", "haproxy"],

  // GitHub routes
  ["routes/github", "integrations"],

  // Backup-related routes
  ["routes/self-backups.ts", "backup"],

  // Settings routes (generally http)
  ["routes/settings", "http"],
  ["routes/azure", "integrations"],
  ["routes/user-preferences.ts", "http"],
  ["routes/system-settings.ts", "http"],
  ["routes/api-routes.ts", "http"],
];

function classify(relPath) {
  for (const [prefix, component] of RULES) {
    if (relPath.startsWith(prefix)) return component;
  }
  // Route fallback
  if (relPath.startsWith("routes/")) return "http";
  // Default
  return "platform";
}

function subcomponentFor(relPath) {
  const file = path.basename(relPath);
  if (file === "index.ts") {
    // use parent directory
    return path.basename(path.dirname(relPath));
  }
  return file.replace(/\.ts$/, "");
}

// Matches: import { xxxLogger } from "...logger-factory";
// Or:      import { xxxLogger, other } from "...logger-factory";
// Or:      import { other, xxxLogger } from "...logger-factory";
const LEGACY_FNS = [
  "appLogger",
  "httpLogger",
  "prismaLogger",
  "servicesLogger",
  "dockerExecutorLogger",
  "deploymentLogger",
  "loadbalancerLogger",
  "selfBackupLogger",
  "tlsLogger",
  "agentLogger",
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT);
let changed = 0;
let skippedExcluded = 0;
let skippedNoMatch = 0;

for (const abs of files) {
  if (isExcluded(abs)) {
    skippedExcluded += 1;
    continue;
  }
  let src = fs.readFileSync(abs, "utf8");

  // Find legacy logger calls in this file.
  const calls = [];
  for (const fn of LEGACY_FNS) {
    const re = new RegExp(`\\b${fn}\\(\\)`, "g");
    if (re.test(src)) calls.push(fn);
  }
  if (calls.length === 0) {
    skippedNoMatch += 1;
    continue;
  }

  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  const component = classify(rel);
  const subcomponent = subcomponentFor(rel);

  let next = src;

  // Rewrite import lines:
  //   import { Fn } from "...logger-factory"
  //   import { Fn, other } from "...logger-factory"
  // We replace the legacy name with getLogger (deduping).
  next = next.replace(
    /import\s*\{\s*([^}]+)\s*\}\s*from\s*(['"])([^'"]*logger-factory)\2\s*;?/g,
    (match, inner, q, modPath) => {
      const names = inner.split(",").map((s) => s.trim()).filter(Boolean);
      const keep = [];
      let hadLegacy = false;
      for (const n of names) {
        if (LEGACY_FNS.includes(n)) {
          hadLegacy = true;
        } else {
          keep.push(n);
        }
      }
      if (!hadLegacy) return match;
      if (!keep.includes("getLogger")) keep.unshift("getLogger");
      return `import { ${keep.join(", ")} } from ${q}${modPath}${q};`;
    },
  );

  // Rewrite usages: xxxLogger() → getLogger("<component>", "<subcomponent>")
  for (const fn of LEGACY_FNS) {
    const re = new RegExp(`\\b${fn}\\(\\)`, "g");
    next = next.replace(re, `getLogger("${component}", "${subcomponent}")`);
  }

  if (next !== src) {
    if (!DRY) fs.writeFileSync(abs, next, "utf8");
    changed += 1;
    process.stdout.write(`  ${component}/${subcomponent}  ${rel}\n`);
  }
}

console.log(`\nFiles rewritten: ${changed}`);
console.log(`Excluded:        ${skippedExcluded}`);
console.log(`No legacy calls: ${skippedNoMatch}`);
if (DRY) console.log("(dry run — no files modified)");
