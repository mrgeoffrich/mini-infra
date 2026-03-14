import { spawn } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RESTART_FILE = resolve(ROOT, ".restart-dev");
const POLL_INTERVAL = 500;

let child = null;
let shuttingDown = false;

function startDev() {
  console.log("\x1b[36m[dev-restart]\x1b[0m Starting dev server...");

  child = spawn("npx", ["concurrently", "npm run dev:lib", "npm run dev:server", "npm run dev:client", "npm run dev:agent-sidecar"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, AGENT_SIDECAR_DEV_URL: "http://localhost:3100" },
  });

  child.on("exit", (code) => {
    child = null;
    if (!shuttingDown) {
      startDev();
    } else {
      process.exit(code ?? 0);
    }
  });
}

function watchForRestart() {
  setInterval(() => {
    if (existsSync(RESTART_FILE)) {
      try {
        unlinkSync(RESTART_FILE);
      } catch {
        // File may have been deleted between check and unlink
        return;
      }
      console.log("\n\x1b[36m[dev-restart]\x1b[0m Restart triggered by .restart-dev file");
      if (child) {
        child.kill("SIGTERM");
        // child's 'exit' handler will call startDev()
      } else {
        startDev();
      }
    }
  }, POLL_INTERVAL);
}

function shutdown() {
  shuttingDown = true;
  if (child) {
    child.kill("SIGTERM");
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Clean up any stale restart file
if (existsSync(RESTART_FILE)) {
  unlinkSync(RESTART_FILE);
}

startDev();
watchForRestart();
