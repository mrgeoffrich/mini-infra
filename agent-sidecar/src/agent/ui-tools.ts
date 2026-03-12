import type Anthropic from "@anthropic-ai/sdk";
import type { SSEEvent } from "../types";

// ---------------------------------------------------------------------------
// UI tool definitions (highlight, navigate, get_current_page)
// ---------------------------------------------------------------------------

export const UI_TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  {
    name: "highlight_element",
    description:
      "Highlight a UI element in the user's browser. The element is identified by its data-tour ID. " +
      "Use this to visually guide users to specific parts of the interface. " +
      "Read the manifest files in docs/ui-elements/ to discover available element IDs for each page.",
    input_schema: {
      type: "object" as const,
      properties: {
        elementId: {
          type: "string",
          description:
            "The data-tour ID of the element to highlight",
        },
        tooltip: {
          type: "string",
          description:
            "Optional tooltip text to show near the highlighted element",
        },
        duration: {
          type: "number",
          description:
            "How long to show the highlight in milliseconds (default 5000)",
        },
      },
      required: ["elementId"],
    },
  },
  {
    name: "navigate_to",
    description:
      "Navigate the user's browser to a specific page in Mini Infra. " +
      "Optionally highlight an element after navigation completes. " +
      "Read the manifest file at docs/ui-elements/index.md for available routes.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "The route path to navigate to (e.g. '/containers', '/deployments')",
        },
        highlightElementId: {
          type: "string",
          description:
            "Optional data-tour ID of an element to highlight after navigation",
        },
        highlightTooltip: {
          type: "string",
          description: "Optional tooltip for the post-navigation highlight",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_current_page",
    description:
      "Get the route path of the page the user is currently viewing in their browser. " +
      "Use this to understand what the user is looking at before providing contextual help.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// UI tool names set (for checking if a tool is a UI tool)
// ---------------------------------------------------------------------------

export const UI_TOOL_NAMES = new Set(["highlight_element", "navigate_to", "get_current_page"]);

// ---------------------------------------------------------------------------
// UI tool executor
// ---------------------------------------------------------------------------

export interface UIToolResult {
  content: string;
  isError: boolean;
  sseEvent?: SSEEvent;
}

export function executeUITool(
  name: string,
  input: Record<string, unknown>,
  currentPath: string,
): UIToolResult {
  switch (name) {
    case "highlight_element": {
      return {
        content: `Highlight request sent for element "${input.elementId}"${input.tooltip ? ` with tooltip "${input.tooltip}"` : ""}.`,
        isError: false,
        sseEvent: {
          type: "ui_highlight",
          data: {
            elementId: input.elementId as string,
            tooltip: (input.tooltip as string) ?? null,
            duration: (input.duration as number) ?? 5000,
          },
        },
      };
    }

    case "navigate_to": {
      const parts = [`Navigation request sent to "${input.path}"`];
      if (input.highlightElementId) {
        parts.push(
          `will attempt to highlight "${input.highlightElementId}" after navigation`,
        );
      }
      return {
        content: parts.join(". ") + ".",
        isError: false,
        sseEvent: {
          type: "ui_navigate",
          data: {
            path: input.path as string,
            highlightElementId: (input.highlightElementId as string) ?? null,
            highlightTooltip: (input.highlightTooltip as string) ?? null,
          },
        },
      };
    }

    case "get_current_page": {
      return {
        content: currentPath || "unknown",
        isError: false,
      };
    }

    default:
      return { content: `Unknown UI tool: ${name}`, isError: true };
  }
}
