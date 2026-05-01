#!/usr/bin/env node
/**
 * Drift check between the TypeScript subject constants in
 * `lib/types/nats-subjects.ts` and their Go mirror in
 * `egress-shared/natsbus/subjects.go`.
 *
 * Both files declare the same contract for system-internal NATS subjects
 * (the `mini-infra.>` namespace). They live in two languages because they
 * are consumed by two runtimes (Node server + Go egress sidecars). This
 * check parses both files and fails CI if the *set* of subject string
 * literals diverges.
 *
 * Why parse instead of codegen: the TS file is `as const` literal-grouped
 * objects that double as documentation; the Go file is plain top-level
 * `const` blocks that the Go ecosystem expects. Generating either side
 * loses readability, and a tiny parser is enough to enforce equivalence.
 *
 * Run via `node scripts/check-nats-subject-drift.mjs` (no deps). CI workflow
 * is `.github/workflows/nats-constants.yml`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const TS_PATH = resolve(REPO_ROOT, "lib/types/nats-subjects.ts");
const GO_PATH = resolve(REPO_ROOT, "egress-shared/natsbus/subjects.go");

/**
 * Extract `mini-infra.*` string literals from a source file. Both TS and Go
 * use the same `"mini-infra.<...>"` literal form, so one regex covers both.
 * Excluding `mini-infra.>` and similar (the wildcards file is separate in TS;
 * Go currently has none) keeps the comparison to concrete subjects only.
 */
function extractSubjects(source) {
  const re = /"(mini-infra\.[a-z0-9.\-]+)"/g;
  const found = new Set();
  for (const m of source.matchAll(re)) {
    const subject = m[1];
    if (subject.includes(">") || subject.includes("*")) continue;
    found.add(subject);
  }
  return found;
}

function diff(setA, setB) {
  const onlyInA = [...setA].filter((s) => !setB.has(s)).sort();
  const onlyInB = [...setB].filter((s) => !setA.has(s)).sort();
  return { onlyInA, onlyInB };
}

const ts = readFileSync(TS_PATH, "utf8");
const go = readFileSync(GO_PATH, "utf8");

const tsSubjects = extractSubjects(ts);
const goSubjects = extractSubjects(go);

const { onlyInA: onlyInTs, onlyInB: onlyInGo } = diff(tsSubjects, goSubjects);

if (onlyInTs.length === 0 && onlyInGo.length === 0) {
  console.log(
    `OK — ${tsSubjects.size} subjects in lock-step between ${TS_PATH} and ${GO_PATH}`,
  );
  process.exit(0);
}

console.error("NATS subject constants drift detected.\n");
if (onlyInTs.length > 0) {
  console.error("Only in TypeScript (lib/types/nats-subjects.ts):");
  for (const s of onlyInTs) console.error(`  + ${s}`);
}
if (onlyInGo.length > 0) {
  console.error("Only in Go (egress-shared/natsbus/subjects.go):");
  for (const s of onlyInGo) console.error(`  + ${s}`);
}
console.error(
  "\nFix: add or remove the missing subject in the file that's behind, " +
    "then re-run `node scripts/check-nats-subject-drift.mjs` locally.",
);
process.exit(1);
