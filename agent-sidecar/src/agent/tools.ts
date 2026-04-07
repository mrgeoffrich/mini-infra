import fs from "fs/promises";
import path from "path";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Environment config
// ---------------------------------------------------------------------------

const DOCS_DIR = process.env.DOCS_DIR ?? "/app/docs";

// ---------------------------------------------------------------------------
// Blocked command patterns for bash tool (exported for canUseTool in runner)
// ---------------------------------------------------------------------------

export const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/($|\s)/,
    reason: "Deleting root filesystem is forbidden",
  },
  {
    pattern: /rm\s+-rf\s+\//,
    reason: "Recursive deletion of root filesystem is forbidden",
  },
  { pattern: /mkfs/, reason: "Filesystem formatting is forbidden" },
  { pattern: /dd\s+if=/, reason: "Disk operations with dd are forbidden" },
  {
    pattern: />\s*\/dev\//,
    reason: "Writing to device files is forbidden",
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

export function checkBashSafety(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "Empty command";

  // Reject newlines and tabs — a shell treats \n as a command terminator
  if (/[\n\r\t]/.test(command)) {
    return "Newlines and tabs are not allowed in commands.";
  }

  // Block backticks and $() subshells — chaining with &&, ||, ; and pipes is allowed
  const subshellPattern = /[`]|\$\(/;
  if (subshellPattern.test(command)) {
    return "Subshell execution (backticks, $()) is not allowed in agent commands.";
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
  if (resolved !== DOCS_DIR && !resolved.startsWith(DOCS_DIR + path.sep)) {
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
  return input;
}

