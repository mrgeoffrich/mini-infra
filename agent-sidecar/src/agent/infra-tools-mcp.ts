import { z } from "zod";
import { tool, createSdkMcpServer } from "./sdk";
import { executeTool, summarizeOutput, type ToolResult } from "./tools";
import type { ToolResultEmitter } from "./runner";

/**
 * Creates an MCP server wrapping the 6 infrastructure tools (bash, mini_infra_api,
 * read_file, write_file, list_docs, read_doc). Each handler delegates to the
 * existing executeTool() function and converts the ToolResult to MCP CallToolResult.
 *
 * The emitter callback is called after each tool execution so the runner can
 * emit tool_result SSE events with the correct tool_use_id.
 */
export function createInfraToolsMcpServer(emitter: ToolResultEmitter) {
  const wrapTool = (
    name: string,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => {
    return async (args: Record<string, unknown>) => {
      const result = await handler(args);
      emitter(name, result);
      return {
        content: [{ type: "text" as const, text: result.content }],
        isError: result.isError,
      };
    };
  };

  const bashTool = tool(
    "bash",
    "Execute a shell command. Available commands: docker, gh, curl, and standard Unix utilities. " +
      "Commands run in /tmp/agent-work/ with a 30-second timeout. " +
      "Use this for Docker CLI operations, GitHub CLI, curl requests, and general diagnostics. " +
      "Command chaining (;, |, &&, ||) is not allowed — run one command at a time.",
    {
      command: z.string().describe("The shell command to execute (single command, no chaining)"),
      timeout_ms: z
        .number()
        .optional()
        .describe("Optional timeout in milliseconds (default 30000, max 120000)"),
    },
    wrapTool("bash", (args) =>
      executeTool("bash", args as { command: string; timeout_ms?: number }),
    ),
  );

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
    wrapTool("mini_infra_api", (args) =>
      executeTool("mini_infra_api", args),
    ),
  );

  const readFileTool = tool(
    "read_file",
    "Read a file from the filesystem. Can read files in /tmp/agent-work/, " +
      "container log files, and other accessible paths.",
    {
      path: z.string().describe("Absolute file path to read"),
      max_lines: z.number().optional().describe("Maximum number of lines to return (default: 500)"),
    },
    wrapTool("read_file", (args) =>
      executeTool("read_file", args as { path: string; max_lines?: number }),
    ),
  );

  const writeFileTool = tool(
    "write_file",
    "Write content to a file. Files can only be written to /tmp/agent-work/. " +
      "Use this for temporary scripts, reports, or diagnostic output.",
    {
      path: z
        .string()
        .describe("File path within /tmp/agent-work/ (e.g., 'report.md', 'script.sh')"),
      content: z.string().describe("File content to write"),
    },
    wrapTool("write_file", (args) =>
      executeTool("write_file", args as { path: string; content: string }),
    ),
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
    wrapTool("list_docs", (args) =>
      executeTool("list_docs", args as { category?: string }),
    ),
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
    wrapTool("read_doc", (args) =>
      executeTool("read_doc", args as { path: string }),
    ),
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "mini-infra-infra",
    version: "1.0.0",
    tools: [bashTool, miniInfraApiTool, readFileTool, writeFileTool, listDocsTool, readDocTool],
  });
}
