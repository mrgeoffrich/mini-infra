/**
 * Dev helper: bootstraps environment for the agent sidecar process.
 *
 * 1. Reads ANTHROPIC_API_KEY (and other agent vars) from server/.env
 * 2. Queries the SQLite dev DB for the agent API key (mk_...)
 * 3. Spawns `tsx watch src/index.ts` inside agent-sidecar/ with the right env vars
 *
 * On first-ever run the agent API key won't exist yet (the server creates it at
 * startup). The sidecar will start without it — API calls to the server will fail
 * until you restart dev. On subsequent runs the key persists in the DB.
 */

import { spawn, execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER_ENV_PATH = resolve(ROOT, "server/.env");
const DB_PATH = resolve(ROOT, "server/prisma/dev.db");
const SIDECAR_DIR = resolve(ROOT, "agent-sidecar");

// ---------------------------------------------------------------------------
// 1. Parse server/.env for ANTHROPIC_API_KEY and agent settings
// ---------------------------------------------------------------------------

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

const serverEnv = parseEnvFile(SERVER_ENV_PATH);

// ---------------------------------------------------------------------------
// 2. Read the agent API key from the SQLite dev database
// ---------------------------------------------------------------------------

let agentApiKey = "";

if (existsSync(DB_PATH)) {
  try {
    const result = execSync(
      `sqlite3 "${DB_PATH}" "SELECT value FROM SystemSettings WHERE category='agent' AND key='agent_api_key' AND isActive=1 LIMIT 1;"`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (result) {
      agentApiKey = result;
      console.log("\x1b[36m[agent-sidecar]\x1b[0m Agent API key loaded from dev database");
    } else {
      console.log("\x1b[33m[agent-sidecar]\x1b[0m No agent API key in database yet (will be created on first server startup)");
    }
  } catch {
    console.log("\x1b[33m[agent-sidecar]\x1b[0m Could not read agent API key from database (server may not have started yet)");
  }
} else {
  console.log("\x1b[33m[agent-sidecar]\x1b[0m Dev database not found at", DB_PATH);
}

// ---------------------------------------------------------------------------
// 3. Spawn tsx watch with the right environment
// ---------------------------------------------------------------------------

const anthropicKey = process.env.ANTHROPIC_API_KEY || serverEnv.ANTHROPIC_API_KEY || "";

if (!anthropicKey) {
  console.log("\x1b[33m[agent-sidecar]\x1b[0m ANTHROPIC_API_KEY not set — agent will start but AI features won't work");
}

const child = spawn("npx", ["tsx", "watch", "src/index.ts"], {
  cwd: SIDECAR_DIR,
  stdio: "inherit",
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: anthropicKey,
    MINI_INFRA_API_KEY: agentApiKey,
    MINI_INFRA_API_URL: "http://localhost:5005",
    DOCS_DIR: resolve(ROOT, "client/src/user-docs"),
    PORT: "3100",
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
