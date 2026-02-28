import { z } from "zod";
import {
  tool,
  createSdkMcpServer,
} from "../lib/agent-sdk";

type BroadcastFn = (event: { type: string; data: Record<string, unknown> }) => void;

/**
 * Creates an MCP server with UI guidance tools (highlight_element, navigate_to).
 * The broadcast callback is closed over per-session so events reach the correct
 * browser tab via SSE.
 */
export function createUiToolsMcpServer(broadcast: BroadcastFn) {
  const highlightTool = tool(
    "highlight_element",
    "Highlight a UI element in the user's browser. The element is identified by its data-tour ID. " +
      "Use this to visually guide users to specific parts of the interface. " +
      "Read the manifest files in docs/ui-elements/ to discover available element IDs for each page.",
    {
      elementId: z.string().describe("The data-tour ID of the element to highlight"),
      tooltip: z.string().optional().describe("Optional tooltip text to show near the highlighted element"),
      duration: z.number().optional().describe("How long to show the highlight in milliseconds (default 5000)"),
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
      return {
        content: [
          {
            type: "text" as const,
            text: `Highlight request sent for element "${args.elementId}"${args.tooltip ? ` with tooltip "${args.tooltip}"` : ""}.`,
          },
        ],
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
      path: z.string().describe("The route path to navigate to (e.g. '/containers', '/deployments')"),
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
      return {
        content: [{ type: "text" as const, text: parts.join(". ") + "." }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "mini-infra-ui",
    version: "1.0.0",
    tools: [highlightTool, navigateTool],
  });
}
