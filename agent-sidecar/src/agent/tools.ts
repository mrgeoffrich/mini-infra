import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Environment config
// ---------------------------------------------------------------------------

const MINI_INFRA_API_URL =
  process.env.MINI_INFRA_API_URL ?? "http://localhost:5000";
const MINI_INFRA_API_KEY = process.env.MINI_INFRA_API_KEY ?? "";
const DOCS_DIR = process.env.DOCS_DIR ?? "/app/docs";
const AGENT_WORK_DIR = "/tmp/agent-work";
const BASH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Tool schema definitions
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  {
    name: "bash",
    description:
      "Execute a shell command. Available commands: docker, gh, curl, and standard Unix utilities. " +
      "Commands run in /tmp/agent-work/ with a 30-second timeout. " +
      "Use this for Docker CLI operations, GitHub CLI, curl requests, and general diagnostics. " +
      "Command chaining (;, |, &&, ||) is not allowed — run one command at a time.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute (single command, no chaining)",
        },
        timeout_ms: {
          type: "number",
          description:
            "Optional timeout in milliseconds (default 30000, max 120000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "mini_infra_api",
    description:
      "Call the Mini Infra REST API. Authentication is handled automatically. " +
      "Use this for structured API operations instead of curl when possible.",
    input_schema: {
      type: "object" as const,
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method",
        },
        path: {
          type: "string",
          description:
            "API path (e.g., '/api/containers', '/api/deployments')",
        },
        body: {
          type: "object",
          description:
            "Optional JSON request body for POST/PUT/PATCH requests",
        },
        query: {
          type: "object",
          description: "Optional query parameters as key-value pairs",
        },
      },
      required: ["method", "path"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file from the filesystem. Can read files in /tmp/agent-work/, " +
      "container log files, and other accessible paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute file path to read",
        },
        max_lines: {
          type: "number",
          description: "Maximum number of lines to return (default: 500)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Files can only be written to /tmp/agent-work/. " +
      "Use this for temporary scripts, reports, or diagnostic output.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "File path within /tmp/agent-work/ (e.g., 'report.md', 'script.sh')",
        },
        content: {
          type: "string",
          description: "File content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_docs",
    description:
      "List available documentation files. Returns file paths organized by directory. " +
      "Use this to find relevant docs before reading them.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description:
            "Optional category/directory filter (e.g., 'containers', 'deployments', 'postgres-backups')",
        },
      },
      required: [],
    },
  },
  {
    name: "read_doc",
    description:
      "Read a specific documentation file from the baked-in docs directory. " +
      "Use the path from list_docs or the documentation index in the system prompt.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the doc file (e.g., 'containers/troubleshooting.md')",
        },
      },
      required: ["path"],
    },
  },
];

// ---------------------------------------------------------------------------
// Blocked command patterns for bash tool
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/($|\s)/,
    reason: "Deleting root filesystem is forbidden",
  },
  {
    pattern: /rm\s+-rf\s+\//,
    reason: "Recursive deletion of root filesystem is forbidden",
  },
  {
    pattern: /docker\s+system\s+prune/,
    reason: "docker system prune can remove in-use resources",
  },
  {
    pattern: /docker\s+volume\s+rm/,
    reason:
      "docker volume rm could delete persistent data. Use Mini Infra API instead",
  },
  {
    pattern: /docker\s+container\s+prune/,
    reason: "docker container prune can remove needed containers",
  },
  {
    pattern: /docker\s+image\s+prune\s+-a/,
    reason: "docker image prune -a removes all unused images",
  },
  { pattern: /mkfs/, reason: "Filesystem formatting is forbidden" },
  { pattern: /dd\s+if=/, reason: "Disk operations with dd are forbidden" },
  {
    pattern: />\s*\/dev\//,
    reason: "Writing to device files is forbidden",
  },
  {
    pattern: /chmod\s+.*\/var\/run\/docker\.sock/,
    reason: "Modifying Docker socket permissions is forbidden",
  },
  { pattern: /kill\s+-9\s+1($|\s)/, reason: "Killing PID 1 is forbidden" },
  { pattern: /shutdown/, reason: "System shutdown is forbidden" },
  { pattern: /reboot/, reason: "System reboot is forbidden" },
  {
    pattern: /git\s+push\s+.*--force/,
    reason: "Force push is forbidden",
  },
  {
    pattern: /git\s+push\s+.*-f($|\s)/,
    reason: "Force push is forbidden",
  },
];

function checkBashSafety(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "Empty command";

  // Reject newlines and tabs — a shell treats \n as a command terminator
  if (/[\n\r\t]/.test(command)) {
    return "Newlines and tabs are not allowed in commands.";
  }

  // No command chaining characters
  const chainPattern = /[;|`]|\$\(|&&|\|\|/;
  if (chainPattern.test(command)) {
    return "Command chaining is not allowed in agent commands.";
  }

  // Check against blocked patterns
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool execution functions
// ---------------------------------------------------------------------------

export interface ToolResult {
  content: string;
  isError: boolean;
}

async function executeBash(input: {
  command: string;
  timeout_ms?: number;
}): Promise<ToolResult> {
  const { command, timeout_ms } = input;

  const violation = checkBashSafety(command);
  if (violation) {
    return { content: `BLOCKED: ${violation}`, isError: true };
  }

  const timeout = Math.min(timeout_ms ?? BASH_TIMEOUT_MS, 120_000);

  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
      cwd: AGENT_WORK_DIR,
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      env: {
        ...process.env,
        MINI_INFRA_API_KEY: MINI_INFRA_API_KEY,
      },
    });

    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { content: output || "(no output)", isError: false };
  } catch (err: unknown) {
    const error = err as {
      code?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    if (error.killed) {
      return {
        content: `Command timed out after ${timeout}ms`,
        isError: true,
      };
    }

    // Non-zero exit code — return output as content, not an error
    const output = [error.stdout, error.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (output) {
      return { content: `Exit code non-zero.\n${output}`, isError: false };
    }

    return {
      content: `Command failed: ${error.message ?? "Unknown error"}`,
      isError: true,
    };
  }
}

async function executeMiniInfraApi(input: {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}): Promise<ToolResult> {
  const { method, path: apiPath, body, query } = input;

  let url = `${MINI_INFRA_API_URL}${apiPath}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams(query);
    url += `?${params.toString()}`;
  }

  try {
    const headers: Record<string, string> = {
      "x-api-key": MINI_INFRA_API_KEY,
      "Content-Type": "application/json",
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(30_000),
    };

    if (body && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    const text = await response.text();

    let content: string;
    try {
      const json = JSON.parse(text);
      content = JSON.stringify(json, null, 2);
    } catch {
      content = text;
    }

    if (!response.ok) {
      return {
        content: `HTTP ${response.status} ${response.statusText}\n${content}`,
        isError: true,
      };
    }

    return { content, isError: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: `API request failed: ${message}`, isError: true };
  }
}

async function executeReadFile(input: {
  path: string;
  max_lines?: number;
}): Promise<ToolResult> {
  const filePath = input.path;
  const maxLines = input.max_lines ?? 500;

  if (filePath.includes("..")) {
    return { content: "Path traversal (..) is not allowed", isError: true };
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    if (lines.length > maxLines) {
      const truncated = lines.slice(0, maxLines).join("\n");
      return {
        content: `${truncated}\n\n... (truncated, showing ${maxLines} of ${lines.length} lines)`,
        isError: false,
      };
    }
    return { content: content || "(empty file)", isError: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: `Failed to read file: ${message}`, isError: true };
  }
}

async function executeWriteFile(input: {
  path: string;
  content: string;
}): Promise<ToolResult> {
  const resolved = path.resolve(AGENT_WORK_DIR, input.path);
  if (!resolved.startsWith(AGENT_WORK_DIR)) {
    return {
      content: `Files can only be written to ${AGENT_WORK_DIR}/`,
      isError: true,
    };
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, input.content, "utf-8");
    return {
      content: `Written to ${resolved} (${input.content.length} bytes)`,
      isError: false,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: `Failed to write file: ${message}`, isError: true };
  }
}

async function executeListDocs(input: {
  category?: string;
}): Promise<ToolResult> {
  try {
    const results: string[] = [];
    const scanDir = input.category
      ? path.join(DOCS_DIR, input.category)
      : DOCS_DIR;

    const exists = await fs
      .stat(scanDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return { content: `Directory not found: ${scanDir}`, isError: true };
    }

    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.name.endsWith(".md")) {
          const relative = path.relative(DOCS_DIR, fullPath);
          results.push(relative);
        }
      }
    }

    await walk(scanDir);
    results.sort();

    if (results.length === 0) {
      return { content: "No documentation files found.", isError: false };
    }

    return { content: results.join("\n"), isError: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: `Failed to list docs: ${message}`, isError: true };
  }
}

async function executeReadDoc(input: { path: string }): Promise<ToolResult> {
  const resolved = path.resolve(DOCS_DIR, input.path);
  if (!resolved.startsWith(DOCS_DIR)) {
    return {
      content: "Path traversal outside docs directory is not allowed",
      isError: true,
    };
  }

  try {
    const content = await fs.readFile(resolved, "utf-8");
    return { content: content || "(empty file)", isError: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: `Failed to read doc: ${message}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  logger.info(
    { tool: name, input: summarizeInput(name, input) },
    "Executing tool",
  );

  switch (name) {
    case "bash":
      return executeBash(input as { command: string; timeout_ms?: number });
    case "mini_infra_api":
      return executeMiniInfraApi(
        input as {
          method: string;
          path: string;
          body?: Record<string, unknown>;
          query?: Record<string, string>;
        },
      );
    case "read_file":
      return executeReadFile(input as { path: string; max_lines?: number });
    case "write_file":
      return executeWriteFile(input as { path: string; content: string });
    case "list_docs":
      return executeListDocs(input as { category?: string });
    case "read_doc":
      return executeReadDoc(input as { path: string });
    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === "write_file" && typeof input.content === "string") {
    return { ...input, content: `(${input.content.length} chars)` };
  }
  if (toolName === "bash" && typeof input.command === "string") {
    return { command: input.command.slice(0, 200) };
  }
  return input;
}

export function summarizeOutput(toolName: string, result: ToolResult): string {
  const text = result.content;
  if (text.length <= 200) return text;

  const lines = text.split("\n");
  if (lines.length > 10) {
    const head = lines.slice(0, 3).join("\n");
    const tail = lines.slice(-3).join("\n");
    return `${head}\n... (${lines.length} lines total) ...\n${tail}`;
  }

  return text.slice(0, 200) + "...";
}
