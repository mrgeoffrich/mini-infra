export {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";

// Re-export types unchanged
export type {
  SDKMessage,
  SDKUserMessage,
  HookCallback,
  PreToolUseHookInput,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";
