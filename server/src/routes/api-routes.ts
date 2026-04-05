import express, { Request, Response, RequestHandler } from "express";
import expressListEndpoints from "express-list-endpoints";
import { requirePermission } from "../middleware/auth";

const router = express.Router();

/**
 * GET /api/routes
 * Returns all registered API routes, generated at runtime via express-list-endpoints.
 * Used by the agent sidecar to build its system prompt dynamically.
 */
router.get(
  "/",
  requirePermission("agent:use") as RequestHandler,
  (req: Request, res: Response) => {
    const app = req.app;
    const endpoints = expressListEndpoints(app);

    // Sort by path for consistent output
    endpoints.sort((a, b) => a.path.localeCompare(b.path));

    // Build a grouped markdown reference the agent can consume
    const groups = new Map<string, string[]>();

    for (const endpoint of endpoints) {
      if (endpoint.methods.length === 0) continue;

      // Derive group from the first two path segments, e.g. /api/containers -> Containers
      const segments = endpoint.path.split("/").filter(Boolean);
      let groupKey: string;
      if (segments[0] === "api" && segments.length >= 2) {
        groupKey = segments[1]
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
      } else if (segments[0] === "auth") {
        groupKey = "Auth";
      } else {
        groupKey = segments[0]?.replace(/\b\w/g, (c) => c.toUpperCase()) || "Root";
      }

      const lines = groups.get(groupKey) || [];
      for (const method of endpoint.methods) {
        lines.push(`- ${method} ${endpoint.path}`);
      }
      groups.set(groupKey, lines);
    }

    let markdown = "## Available API Endpoints\n\n";
    for (const [group, lines] of groups) {
      markdown += `### ${group}\n`;
      markdown += lines.join("\n") + "\n\n";
    }

    res.json({
      success: true,
      data: {
        endpoints,
        markdown: markdown.trim(),
      },
    });
  },
);

export default router;
