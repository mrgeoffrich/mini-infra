#!/usr/bin/env node
// One-shot: inject getLogger / clearLoggerCache / createChildLogger /
// selfBackupLogger / serializeError into every per-file vi.mock(.../logger-factory) block.
// Reuses the existing appLogger/servicesLogger body verbatim so the inserted
// getLogger returns the SAME mock instance the legacy exports returned. This is
// important because tests assert on that instance's call record.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("server/src");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const LEGACY = [
  "appLogger", "httpLogger", "prismaLogger", "servicesLogger",
  "dockerExecutorLogger", "deploymentLogger", "loadbalancerLogger",
  "selfBackupLogger", "tlsLogger", "agentLogger",
];

// Find the balanced value expression starting at `start` (positioned at the
// first char of the value, e.g. the `v` in `vi.fn(...)`), following tokens
// until we hit a top-level `,` or `}` that closes the parent object.
function extractValue(src, start) {
  let i = start;
  let depth = 0;
  let inStr = null; // " ' `
  let end = -1;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") { i += 2; continue; }
      if (c === inStr) inStr = null;
    } else {
      if (c === '"' || c === "'" || c === "`") { inStr = c; }
      else if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") {
        if (depth === 0) { end = i; break; }
        depth--;
      }
      else if (c === "," && depth === 0) { end = i; break; }
    }
    i++;
  }
  return { value: src.slice(start, end).trimEnd(), end };
}

let patched = 0;
let skipped = 0;

for (const abs of walk(ROOT)) {
  let src = fs.readFileSync(abs, "utf8");
  if (!/vi\.mock\(\s*['"][^'"]*logger-factory/.test(src)) continue;
  if (/getLogger:\s*vi\.fn/.test(src)) { skipped += 1; continue; }

  // Scope: find the mock block for logger-factory only.
  const mockStart = src.search(/vi\.mock\(\s*['"][^'"]*logger-factory/);
  if (mockStart === -1) continue;

  // Find a legacy entry inside that mock block.
  const slice = src.slice(mockStart, mockStart + 8000);
  const entryRe = new RegExp(`\\b(${LEGACY.join("|")})\\s*:\\s*`);
  const m = entryRe.exec(slice);
  if (!m) continue;

  const valueStart = mockStart + m.index + m[0].length;
  const { value, end } = extractValue(src, valueStart);
  if (!value || end === -1) continue;

  // Compose the additions. Use the same indentation as the matched legacy entry.
  // Find the indentation: look back from mockStart + m.index to the beginning of line.
  const lineStart = src.lastIndexOf("\n", mockStart + m.index) + 1;
  const indent = src.slice(lineStart, mockStart + m.index).match(/^\s*/)[0];

  const insertion =
    `${indent}getLogger: ${value},\n` +
    `${indent}clearLoggerCache: vi.fn(),\n` +
    `${indent}createChildLogger: ${value},\n` +
    `${indent}selfBackupLogger: ${value},\n` +
    `${indent}serializeError: (e: unknown) => e,\n`;

  // Insert the new lines BEFORE the matched legacy entry's line.
  const next = src.slice(0, lineStart) + insertion + src.slice(lineStart);
  fs.writeFileSync(abs, next, "utf8");
  patched += 1;
  process.stdout.write(`  patched ${path.relative(ROOT, abs)}\n`);
}

console.log(`\nPatched ${patched} files (skipped ${skipped} already-patched).`);
