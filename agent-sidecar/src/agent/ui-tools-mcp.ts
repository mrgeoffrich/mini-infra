import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { SSEEvent } from "../types";

type BroadcastFn = (event: SSEEvent) => void;
type GetCurrentPathFn = () => string;

/**
 * Creates an MCP server with UI guidance tools (highlight_element, navigate_to,
 * get_current_page). The broadcast callback is closed over per-session so SSE
 * events reach the correct client.
 */
export function createUiToolsMcpServer(
  broadcast: BroadcastFn,
  getCurrentPath: GetCurrentPathFn,
) {
  const highlightTool = tool(
    "highlight_element",
    "Highlight a UI element in the user's browser. The element is identified by its data-tour ID. " +
      "Use this to visually guide users to specific parts of the interface. " +
      "Read the manifest files in docs/ui-elements/ to discover available element IDs for each page.",
    {
      elementId: z.string().describe("The data-tour ID of the element to highlight"),
      tooltip: z
        .string()
        .optional()
        .describe("Optional tooltip text to show near the highlighted element"),
      duration: z
        .number()
        .optional()
        .describe("How long to show the highlight in milliseconds (default 5000)"),
    },
    async (args) => {
      broadcast({
        type: "ui_highlight",
        data: {
          elementId: args.elementId,
          tooltip: args.tooltip ?? null,
          duration: args.duration ?? 5000,
        },
      });
      const text = `Highlight request sent for element "${args.elementId}"${args.tooltip ? ` with tooltip "${args.tooltip}"` : ""}.`;
      return {
        content: [{ type: "text" as const, text }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  const navigateTool = tool(
    "navigate_to",
    "Navigate the user's browser to a specific page in Mini Infra. " +
      "Optionally highlight an element after navigation completes. " +
      "Read the manifest file at docs/ui-elements/index.md for available routes.",
    {
      path: z
        .string()
        .describe("The route path to navigate to (e.g. '/containers', '/deployments')"),
      highlightElementId: z
        .string()
        .optional()
        .describe("Optional data-tour ID of an element to highlight after navigation"),
      highlightTooltip: z
        .string()
        .optional()
        .describe("Optional tooltip for the post-navigation highlight"),
    },
    async (args) => {
      broadcast({
        type: "ui_navigate",
        data: {
          path: args.path,
          highlightElementId: args.highlightElementId ?? null,
          highlightTooltip: args.highlightTooltip ?? null,
        },
      });
      const parts = [`Navigation request sent to "${args.path}"`];
      if (args.highlightElementId) {
        parts.push(`will attempt to highlight "${args.highlightElementId}" after navigation`);
      }
      const text = parts.join(". ") + ".";
      return {
        content: [{ type: "text" as const, text }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  const getCurrentPageTool = tool(
    "get_current_page",
    "Get the route path of the page the user is currently viewing in their browser. " +
      "Use this to understand what the user is looking at before providing contextual help.",
    {},
    async () => {
      const currentPath = getCurrentPath();
      const text = currentPath || "unknown";
      return {
        content: [{ type: "text" as const, text }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "mini-infra-ui",
    version: "1.0.0",
    tools: [highlightTool, navigateTool, getCurrentPageTool],
  });
}
