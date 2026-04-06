import fs from "fs";
import path from "path";
import { logger } from "../logger";

const DOCS_DIR = process.env.DOCS_DIR ?? "/app/docs";

// ---------------------------------------------------------------------------
// Frontmatter parser (lightweight, no external dependency)
// ---------------------------------------------------------------------------

interface DocMeta {
  filePath: string;
  title: string;
  description: string;
  category: string;
  order: number;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build docs index at startup
// ---------------------------------------------------------------------------

function scanDocs(dir: string, base: string = dir): DocMeta[] {
  const results: DocMeta[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanDocs(fullPath, base));
    } else if (entry.name.endsWith(".md")) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const fm = parseFrontmatter(content);
        results.push({
          filePath: path.relative(base, fullPath),
          title: fm.title ?? entry.name.replace(".md", ""),
          description: fm.description ?? "",
          category: fm.category ?? path.basename(dir),
          order: parseInt(fm.order ?? "99", 10),
        });
      } catch (err) {
        logger.warn({ err, file: fullPath }, "Failed to parse doc frontmatter");
      }
    }
  }
  return results;
}

function buildDocsIndex(): string {
  const docs = scanDocs(DOCS_DIR);
  if (docs.length === 0) {
    return "No documentation files found.";
  }

  const byCategory = new Map<string, DocMeta[]>();
  for (const doc of docs) {
    const list = byCategory.get(doc.category) ?? [];
    list.push(doc);
    byCategory.set(doc.category, list);
  }

  const lines: string[] = ["## Available Documentation", ""];
  lines.push(
    "Use the `read_doc` MCP tool or the built-in `Read` tool to read any of these files.",
    "",
  );

  for (const [category, categoryDocs] of byCategory) {
    categoryDocs.sort((a, b) => a.order - b.order);
    lines.push(`### ${category}`);
    for (const doc of categoryDocs) {
      lines.push(
        `- **${doc.title}** (\`${doc.filePath}\`) — ${doc.description}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Static prompt parts
// ---------------------------------------------------------------------------

const CORE_IDENTITY = `You are an AI operations assistant for Mini Infra, a web application that manages a single Docker host and its supporting infrastructure (containers, deployments, PostgreSQL backups, HAProxy load balancer, TLS certificates, and Cloudflare tunnels).

You run inside a sidecar container with direct access to:
- The Docker socket (docker CLI)
- The GitHub CLI (gh)
- curl for HTTP requests
- The Mini Infra REST API

Your job is to help diagnose issues, answer questions about the infrastructure, perform operational tasks, and guide users through Mini Infra features. You are thorough, accurate, and cautious with destructive operations.`;

const SAFETY_RULES = `## Safety Rules

You MUST follow these rules at all times:

### Absolutely Forbidden
- Never run \`rm -rf /\` or any command that recursively deletes the root filesystem
- Never run \`docker system prune\` — this can remove images, containers, and volumes in use
- Never run \`docker volume rm\` without explicit user confirmation
- Never run \`mkfs\`, \`dd if=\`, or write to \`/dev/\` devices
- Never run \`git push --force\` to main/master branches
- Never expose secrets, API keys, or credentials in your responses
- Never modify the sidecar's own container or the Mini Infra main container

### Caution Required
- Before stopping or restarting containers, explain what will happen and confirm with the user
- Before deleting any resource, list what will be affected and get confirmation
- When executing commands that modify state, prefer dry-run or read-only operations first
- If a command fails, explain the error clearly before retrying

### General Principles
- Prefer the Mini Infra API for structured operations (deployments, backups, settings)
- Use Docker CLI for live diagnostics (logs, stats, inspect) that the API doesn't cover
- Be concise — summarize large outputs rather than dumping raw JSON
- Always use \`-s\` (silent) flag with curl to suppress progress bars`;

const TOOL_USAGE_GUIDELINES = `## Tool Usage Guidelines

### Built-in Tools
You have access to the following built-in tools provided by the SDK:
- **Bash**: Execute shell commands (docker, gh, curl, and standard Unix utilities). Commands run in /tmp/agent-work/.
- **Read**: Read any file accessible to the sidecar (logs, configs, docs, temporary outputs).
- **Glob**: Find files by glob pattern (e.g. \`/app/docs/**/*.md\`).
- **Grep**: Search file contents by regex pattern.

### When to use \`Bash\`
- Docker CLI commands: \`docker ps\`, \`docker logs\`, \`docker inspect\`, \`docker stats\`
- GitHub CLI: \`gh pr list\`, \`gh issue view\`, \`gh run list\`
- You can chain commands with \`&&\`, \`||\`, \`;\`, and \`|\`

### Calling the Mini Infra API
**Always use the \`api_request\` MCP tool** to call the Mini Infra REST API. It handles the base URL and authentication automatically. Do NOT use curl for Mini Infra API calls.

Examples:
- List containers: \`api_request(method: "GET", path: "/api/containers")\`
- Get docker info: \`api_request(method: "GET", path: "/api/docker/info")\`
- POST with body: \`api_request(method: "POST", path: "/api/some/endpoint", body: '{"key":"value"}')\`

### User Documentation
User-facing documentation is stored in \`/app/docs/\`. These markdown files describe how the Mini Infra UI works, including page layouts, features, workflows, and configuration options. When the user asks how something works in the UI, search the docs first using \`Glob\` (e.g. \`/app/docs/**/*.md\`) and \`Grep\` to find relevant articles before answering. You can also use the \`list_docs\` and \`read_doc\` MCP tools to browse and read documentation files.`;

// ---------------------------------------------------------------------------
// Dynamic API reference — fetched from the server at startup
// ---------------------------------------------------------------------------

const MINI_INFRA_API_URL = process.env.MINI_INFRA_API_URL || "http://localhost:5005";
const MINI_INFRA_API_KEY = process.env.MINI_INFRA_API_KEY || "";

let cachedApiReference: string | null = null;

const API_REFERENCE_HEADER = `## Mini Infra API Endpoints

Use the \`api_request\` MCP tool to call these endpoints. Authentication is handled automatically.
You can discover all available endpoints by calling GET /api/routes.`;

/**
 * Fetch the route list from the server. Retries a few times in case the
 * sidecar starts before the main server is ready.
 */
export async function initApiReference(maxRetries = 5, delayMs = 3000): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${MINI_INFRA_API_URL}/api/routes`, {
        headers: { "x-api-key": MINI_INFRA_API_KEY },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const body = await res.json() as { success: boolean; data?: { markdown?: string } };
      if (body.success && body.data?.markdown) {
        cachedApiReference = `${API_REFERENCE_HEADER}\n\n${body.data.markdown}`;
        logger.info("API reference fetched from server successfully");
        return;
      }
      throw new Error("Unexpected response shape from /api/routes");
    } catch (err: any) {
      logger.warn(
        { attempt, maxRetries, error: err.message },
        "Failed to fetch API reference from server, will retry",
      );
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  logger.warn("Exhausted retries fetching API reference — agent will rely on GET /api/routes tool calls");
}

function getApiReference(): string {
  return cachedApiReference ?? API_REFERENCE_HEADER;
}

// ---------------------------------------------------------------------------
// Exported builder
// ---------------------------------------------------------------------------

let cachedPrompt: string | null = null;

export function buildSystemPrompt(): string {
  if (cachedPrompt) return cachedPrompt;

  const docsIndex = buildDocsIndex();

  cachedPrompt = [
    CORE_IDENTITY,
    docsIndex,
    TOOL_USAGE_GUIDELINES,
    SAFETY_RULES,
    getApiReference(),
  ].join("\n\n");

  logger.info({ promptLength: cachedPrompt.length }, "System prompt assembled");

  return cachedPrompt;
}

export function resetPromptCache(): void {
  cachedPrompt = null;
}
