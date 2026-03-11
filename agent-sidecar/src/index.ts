import express from "express";
import { logger } from "./logger";
import { SessionStore } from "./session-store";
import { createHealthRouter } from "./routes/health";
import { createSessionsRouter } from "./routes/sessions";
import { requireAuth } from "./middleware/auth";
import { buildSystemPrompt } from "./agent/system-prompt";

const PORT = parseInt(process.env.PORT ?? "3100", 10);

const app = express();
const store = new SessionStore();

app.use(express.json());

// Health endpoint — no auth (used by Docker health checks)
app.use("/health", createHealthRouter(store));

// Session routes — auth required
app.use("/sessions", requireAuth, createSessionsRouter(store));

function shutdown(signal: string): void {
  logger.info({ signal }, "Received shutdown signal, shutting down gracefully");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Validate required env vars
if (!process.env.ANTHROPIC_API_KEY) {
  logger.warn(
    "ANTHROPIC_API_KEY is not set — agent will fail on session creation",
  );
}

// Build and cache the system prompt at startup
try {
  const prompt = buildSystemPrompt();
  logger.info(
    { promptLength: prompt.length },
    "System prompt cached at startup",
  );
} catch (err) {
  logger.error(
    { err },
    "Failed to build system prompt — agent may not function correctly",
  );
}

app.listen(PORT, () => {
  logger.info({ port: PORT }, "Agent sidecar server started");
});
