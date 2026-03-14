import { z } from "zod";
import { tool, createSdkMcpServer } from "./sdk";
import { executeTool, type ToolResult } from "./tools";

/**
 * Creates an MCP server wrapping the domain-specific infrastructure tools
 * (mini_infra_api, list_docs, read_doc). Generic tools like bash, read, and
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

  const miniInfraApiTool = tool(
    "mini_infra_api",
    "Call the Mini Infra REST API. Authentication is handled automatically. " +
      "Use this for structured API operations instead of curl when possible.",
    {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
      path: z.string().describe("API path (e.g., '/api/containers', '/api/deployments')"),
      body: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional JSON request body for POST/PUT/PATCH requests"),
      query: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional query parameters as key-value pairs"),
    },
    async (args) => toCallToolResult(await executeTool("mini_infra_api", args)),
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
    tools: [miniInfraApiTool, listDocsTool, readDocTool],
  });
}
