import express from "express";
import { logger } from "./logger";
import { TurnStore } from "./turn-store";
import { createHealthRouter } from "./routes/health";
import { createTurnsRouter } from "./routes/turns";
import { requireAuth } from "./middleware/auth";
import { buildSystemPrompt, initApiReference, resetPromptCache } from "./agent/system-prompt";

const PORT = parseInt(process.env.PORT ?? "3100", 10);

const app = express();
const store = new TurnStore();

app.use(express.json());

// Health endpoint — no auth (used by Docker health checks)
app.use("/health", createHealthRouter(store));

// Turn routes — auth required
app.use("/turns", requireAuth, createTurnsRouter(store));

function shutdown(signal: string): void {
  logger.info({ signal }, "Received shutdown signal, shutting down gracefully");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Validate required env vars
if (!process.env.ANTHROPIC_API_KEY) {
  logger.warn(
    "ANTHROPIC_API_KEY is not set — agent will fail on turn creation",
  );
}

// Fetch API routes from the server, then build and cache the system prompt
(async () => {
  try {
    await initApiReference();
    resetPromptCache();
    const prompt = buildSystemPrompt();
    logger.info(
      { promptLength: prompt.length },
      "System prompt cached at startup (with dynamic API routes)",
    );
  } catch (err) {
    logger.error(
      { err },
      "Failed to build system prompt — agent may not function correctly",
    );
  }
})();

app.listen(PORT, () => {
  logger.info({ port: PORT }, "Agent sidecar server started");
});
