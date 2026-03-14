import * as originalSdk from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logger";

let sdk: typeof originalSdk = originalSdk;

if (process.env.LANGSMITH_TRACING === "true") {
  try {
    const { wrapClaudeAgentSDK } = require("langsmith/experimental/anthropic");
    sdk = wrapClaudeAgentSDK(originalSdk);
    logger.info(
      {
        project: process.env.LANGSMITH_PROJECT ?? "(default)",
        endpoint:
          process.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com",
      },
      "LangSmith tracing enabled for Claude Agent SDK",
    );
  } catch (err) {
    logger.warn(
      { err },
      "LANGSMITH_TRACING is enabled but failed to load langsmith wrapper — tracing will be disabled",
    );
  }
}

export const query = sdk.query;
export const tool = sdk.tool;
export const createSdkMcpServer = sdk.createSdkMcpServer;

// Re-export types unchanged
export type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
