/**
 * Phase 3 of the Docker network management overhaul
 * (docs/planning/not-shipped/docker-network-overhaul-plan.md §6): "no code
 * outside `services/networks/` talks to Docker's network API."
 *
 * Docker network handling used to be spread across ~10 mechanisms in ~15
 * files, each with its own idempotency check (substring-matching Docker
 * error messages — defect F1) and, in the worst case, two independent
 * `removeNetwork` implementations with different safety semantics (defect
 * F2 — see docs/designs/docker-network-management-redesign.md §1.1). Phases
 * 1–3 moved every one of those call sites behind `NetworkManager`
 * (`services/networks/network-manager.ts`). This test is the enforcement
 * mechanism the plan calls for (§7, "CI gate mechanics"): it scans the live
 * `server/src` tree (mirroring the `permission-constants-sweep.test.ts` /
 * `api-routes-drift.test.ts` pattern of asserting against real source
 * rather than a frozen snapshot) for raw Docker network API call shapes and
 * fails loudly if one exists outside the allowlist.
 *
 * If this test fails: the flagged call almost certainly needs to become
 * `NetworkManager.ensure()/connect()/disconnect()/remove()/removeByOwner()/
 * exists()/inspect()` (construct one via `createNetworkManager(dockerExecutorOrService)`
 * from `services/networks`) instead of talking to dockerode directly. Do
 * NOT widen the allowlist to make this pass — a new raw call site is exactly
 * the regression this test exists to catch.
 *
 * What's gated and why:
 *   - `.getNetwork(`   — dockerode's handle-acquisition call. Every current
 *                        connect/disconnect/remove/inspect-for-mutation site
 *                        in this codebase goes through `docker.getNetwork(name)`
 *                        first, so this one pattern captures all of them.
 *   - `.createNetwork(` — raw network creation.
 *   - `network.connect(` / `network.disconnect(` / `network.remove(` —
 *     defense in depth in case a network handle is acquired indirectly
 *     (not literally via `.getNetwork(` in the same file) and mutated.
 *
 * Deliberately NOT gated: `.listNetworks(`. Listing all Docker networks for
 * display (`DockerService.listNetworks()` — GET /api/docker/networks, the
 * raw networks tab) is an explicit *non-goal* of this consolidation (design
 * doc §3: "the raw networks tab keeps list + delete... not a product goal")
 * and stays a legitimate, cache-backed read API on `DockerService` — the
 * same "call the wrapper, not raw dockerode" convention this project already
 * follows for containers (`DockerService.listContainers()`). Gating on the
 * substring `.listNetworks(` would flag every legitimate caller of that
 * wrapper (`routes/docker.ts`, `egress-network-allocator.ts`, `DockerService`
 * itself), not just raw dockerode use — the read/display surface was never
 * part of the leak/fragility defects (F1–F6, L1–L4) this phase fixes.
 */
import fs from "fs";
import path from "path";

const SERVER_SRC_DIR = path.resolve(__dirname, "..");

/** The ONLY place permitted to call Docker's network API. */
const ALLOWLISTED_DIR = path.join(SERVER_SRC_DIR, "services", "networks");

/** Directory names never walked (generated code, test scaffolding, this test itself). */
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "generated", "__tests__"]);

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkTsFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path.join(dir, entry.name));
    }
  }
}

const RAW_NETWORK_API_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: ".getNetwork(", re: /\.getNetwork\(/ },
  { label: ".createNetwork(", re: /\.createNetwork\(/ },
  { label: "network.connect(", re: /\bnetwork\.connect\(/ },
  { label: "network.disconnect(", re: /\bnetwork\.disconnect\(/ },
  { label: "network.remove(", re: /\bnetwork\.remove\(/ },
];

interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

function findRawNetworkApiCalls(): Violation[] {
  const files: string[] = [];
  walkTsFiles(SERVER_SRC_DIR, files);

  const violations: Violation[] = [];
  for (const file of files) {
    if (file.startsWith(ALLOWLISTED_DIR)) continue;

    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    lines.forEach((lineText, idx) => {
      for (const { label, re } of RAW_NETWORK_API_PATTERNS) {
        if (re.test(lineText)) {
          violations.push({
            file: path.relative(SERVER_SRC_DIR, file),
            line: idx + 1,
            label,
            text: lineText.trim(),
          });
        }
      }
    });
  }
  return violations;
}

describe("Docker network API boundary (network overhaul Phase 3 CI gate)", () => {
  it("walks a non-trivial number of source files (sanity check on the harness itself)", () => {
    const files: string[] = [];
    walkTsFiles(SERVER_SRC_DIR, files);
    expect(files.length).toBeGreaterThan(100);
  });

  it("the allowlist directory actually exists and contains NetworkManager (sanity check the allowlist isn't stale)", () => {
    expect(fs.existsSync(ALLOWLISTED_DIR)).toBe(true);
    expect(fs.existsSync(path.join(ALLOWLISTED_DIR, "network-manager.ts"))).toBe(true);
  });

  it("has zero raw Docker network API calls (.getNetwork(/.createNetwork(/network.connect(/network.disconnect(/network.remove() outside services/networks/", () => {
    const violations = findRawNetworkApiCalls();

    if (violations.length > 0) {
      const details = violations.map((v) => `  ${v.file}:${v.line} [${v.label}] ${v.text}`).join("\n");
      throw new Error(
        `${violations.length} raw Docker network API call(s) found outside server/src/services/networks/. ` +
          `Route each through NetworkManager (construct via createNetworkManager() from '../networks') instead:\n${details}`,
      );
    }

    expect(violations).toEqual([]);
  });
});
