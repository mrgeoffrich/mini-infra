import { z } from "zod";
import { tool, createSdkMcpServer } from "./sdk";
import { executeTool, type ToolResult } from "./tools";

const MINI_INFRA_API_URL = process.env.MINI_INFRA_API_URL || "http://localhost:5005";
const MINI_INFRA_API_KEY = process.env.MINI_INFRA_API_KEY || "";

/**
 * Creates an MCP server wrapping the domain-specific infrastructure tools
 * (list_docs, read_doc, api_request). Generic tools like bash, read, and
 * write are provided by the SDK's built-in tools instead.
 *
 * Each handler delegates to the existing executeTool() function and converts
 * the ToolResult to MCP CallToolResult.
 */
export function createInfraToolsMcpServer() {
  const toCallToolResult = (result: ToolResult) => ({
    content: [{ type: "text" as const, text: result.content }],
    isError: result.isError,
  });

  const apiRequestTool = tool(
    "api_request",
    "Make an authenticated request to the Mini Infra REST API. " +
      "Handles base URL and API key automatically. " +
      "Use this instead of curl for all Mini Infra API calls.",
    {
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
        .default("GET")
        .describe("HTTP method"),
      path: z
        .string()
        .describe("API path (e.g., '/api/containers', '/api/docker/info')"),
      body: z
        .string()
        .optional()
        .describe("JSON request body for POST/PUT/PATCH requests"),
    },
    async (args) => {
      const url = `${MINI_INFRA_API_URL}${args.path}`;
      try {
        const headers: Record<string, string> = {
          "x-api-key": MINI_INFRA_API_KEY,
        };
        const init: RequestInit = {
          method: args.method,
          headers,
        };
        if (args.body && ["POST", "PUT", "PATCH"].includes(args.method)) {
          headers["Content-Type"] = "application/json";
          init.body = args.body;
        }
        const response = await fetch(url, init);
        const text = await response.text();
        if (!response.ok) {
          return {
            content: [{ type: "text" as const, text: `HTTP ${response.status}: ${text}` }],
            isError: true,
          };
        }
        // Try to pretty-print JSON
        try {
          const json = JSON.parse(text);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(json, null, 2) }],
            isError: false,
          };
        } catch {
          return {
            content: [{ type: "text" as const, text }],
            isError: false,
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: `Request failed: ${message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: false } },
  );

  const listDocsTool = tool(
    "list_docs",
    "List available documentation files. Returns file paths organized by directory. " +
      "Use this to find relevant docs before reading them.",
    {
      category: z
        .string()
        .optional()
        .describe(
          "Optional category/directory filter (e.g., 'containers', 'deployments', 'postgres-backups')",
        ),
    },
    async (args) => toCallToolResult(await executeTool("list_docs", args as Record<string, unknown>)),
    { annotations: { readOnlyHint: true } },
  );

  const readDocTool = tool(
    "read_doc",
    "Read a specific documentation file from the baked-in docs directory. " +
      "Use the path from list_docs or the documentation index in the system prompt.",
    {
      path: z
        .string()
        .describe("Relative path to the doc file (e.g., 'containers/troubleshooting.md')"),
    },
    async (args) => toCallToolResult(await executeTool("read_doc", args)),
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "mini-infra-infra",
    version: "1.0.0",
    tools: [apiRequestTool, listDocsTool, readDocTool],
  });
}
