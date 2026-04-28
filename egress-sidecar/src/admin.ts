/**
 * Admin HTTP API server.
 *
 * Endpoints:
 *   POST /admin/rules           — full snapshot replace of stack policies
 *   POST /admin/container-map  — full snapshot replace of container IP map
 *   GET  /admin/health         — health check
 *   GET  /admin/stats          — query counters
 */

import express, {
  Request,
  Response,
  NextFunction,
} from "express";
import { config } from "./config";
import { logger } from "./logging";
import {
  getState,
  applyRules,
  applyContainerMap,
} from "./state";
import type {
  RulesSnapshotRequest,
  RulesSnapshotResponse,
  ContainerMapRequest,
  ContainerMapResponse,
  HealthResponse,
  StatsResponse,
  ErrorResponse,
  StackPolicy,
  ContainerMapEntry,
} from "./types";

const STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isIPv4(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
}

/** Validate a RulesSnapshotRequest payload. Returns error string or null. */
function validateRulesRequest(
  body: unknown,
): { error: string; detail?: unknown } | null {
  if (!isPlainObject(body)) {
    return { error: "Request body must be a JSON object" };
  }
  if (typeof body.version !== "number") {
    return { error: "Missing required field: version (number)" };
  }
  if (!isPlainObject(body.stackPolicies)) {
    return { error: "Missing required field: stackPolicies (object)" };
  }
  if (body.defaultUpstream !== undefined && !isStringArray(body.defaultUpstream)) {
    return { error: "Field defaultUpstream must be an array of strings" };
  }

  for (const [stackId, rawPolicy] of Object.entries(body.stackPolicies)) {
    if (!isPlainObject(rawPolicy)) {
      return { error: `stackPolicies.${stackId} must be an object` };
    }
    if (rawPolicy.mode !== "detect" && rawPolicy.mode !== "enforce") {
      return { error: `stackPolicies.${stackId}.mode must be 'detect' or 'enforce'` };
    }
    if (rawPolicy.defaultAction !== "allow" && rawPolicy.defaultAction !== "block") {
      return {
        error: `stackPolicies.${stackId}.defaultAction must be 'allow' or 'block'`,
      };
    }
    if (!Array.isArray(rawPolicy.rules)) {
      return { error: `stackPolicies.${stackId}.rules must be an array` };
    }
    for (let i = 0; i < rawPolicy.rules.length; i++) {
      const rule = rawPolicy.rules[i];
      if (!isPlainObject(rule)) {
        return { error: `stackPolicies.${stackId}.rules[${i}] must be an object` };
      }
      if (typeof rule.id !== "string") {
        return { error: `stackPolicies.${stackId}.rules[${i}].id must be a string` };
      }
      if (typeof rule.pattern !== "string") {
        return {
          error: `stackPolicies.${stackId}.rules[${i}].pattern must be a string`,
        };
      }
      if (rule.action !== "allow" && rule.action !== "block") {
        return {
          error: `stackPolicies.${stackId}.rules[${i}].action must be 'allow' or 'block'`,
        };
      }
      if (!isStringArray(rule.targets)) {
        return {
          error: `stackPolicies.${stackId}.rules[${i}].targets must be an array of strings`,
        };
      }
      // Check for unexpected fields.
      const knownRuleFields = new Set(["id", "pattern", "action", "targets"]);
      const extraFields = Object.keys(rule).filter((k) => !knownRuleFields.has(k));
      if (extraFields.length > 0) {
        return {
          error: `stackPolicies.${stackId}.rules[${i}] has unexpected fields: ${extraFields.join(", ")}`,
        };
      }
    }
    // Check for unexpected policy fields.
    const knownPolicyFields = new Set(["mode", "defaultAction", "rules"]);
    const extraPolicyFields = Object.keys(rawPolicy).filter(
      (k) => !knownPolicyFields.has(k),
    );
    if (extraPolicyFields.length > 0) {
      return {
        error: `stackPolicies.${stackId} has unexpected fields: ${extraPolicyFields.join(", ")}`,
      };
    }
  }

  // Check for unexpected top-level fields.
  const knownTopFields = new Set(["version", "stackPolicies", "defaultUpstream"]);
  const extraTopFields = Object.keys(body).filter((k) => !knownTopFields.has(k));
  if (extraTopFields.length > 0) {
    return { error: `Request body has unexpected fields: ${extraTopFields.join(", ")}` };
  }

  return null;
}

/** Validate a ContainerMapRequest payload. Returns error string or null. */
function validateContainerMapRequest(
  body: unknown,
): { error: string; detail?: unknown } | null {
  if (!isPlainObject(body)) {
    return { error: "Request body must be a JSON object" };
  }
  if (typeof body.version !== "number") {
    return { error: "Missing required field: version (number)" };
  }
  if (!Array.isArray(body.entries)) {
    return { error: "Missing required field: entries (array)" };
  }
  for (let i = 0; i < body.entries.length; i++) {
    const entry = body.entries[i];
    if (!isPlainObject(entry)) {
      return { error: `entries[${i}] must be an object` };
    }
    if (typeof entry.ip !== "string") {
      return { error: `entries[${i}].ip must be a string` };
    }
    if (typeof entry.stackId !== "string") {
      return { error: `entries[${i}].stackId must be a string` };
    }
    if (typeof entry.serviceName !== "string") {
      return { error: `entries[${i}].serviceName must be a string` };
    }
    if (entry.containerId !== undefined && typeof entry.containerId !== "string") {
      return { error: `entries[${i}].containerId must be a string if present` };
    }
    // Check for unexpected entry fields.
    const knownEntryFields = new Set(["ip", "stackId", "serviceName", "containerId"]);
    const extraFields = Object.keys(entry).filter((k) => !knownEntryFields.has(k));
    if (extraFields.length > 0) {
      return {
        error: `entries[${i}] has unexpected fields: ${extraFields.join(", ")}`,
      };
    }
  }

  // Check for unexpected top-level fields.
  const knownTopFields = new Set(["version", "entries"]);
  const extraTopFields = Object.keys(body).filter((k) => !knownTopFields.has(k));
  if (extraTopFields.length > 0) {
    return { error: `Request body has unexpected fields: ${extraTopFields.join(", ")}` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

export function createAdminApp(): express.Application {
  const app = express();

  app.use(express.json());

  // Reject non-JSON content type for POST endpoints.
  function requireJson(req: Request, res: Response, next: NextFunction): void {
    if (
      req.method === "POST" &&
      !req.is("application/json")
    ) {
      const err: ErrorResponse = {
        error: "Content-Type must be application/json",
      };
      res.status(415).json(err);
      return;
    }
    next();
  }

  app.use(requireJson);

  // ---------------------------------------------------------------------------
  // POST /admin/rules
  // ---------------------------------------------------------------------------
  app.post("/admin/rules", (req: Request, res: Response) => {
    const validationError = validateRulesRequest(req.body);
    if (validationError) {
      res.status(400).json(validationError satisfies ErrorResponse);
      return;
    }

    const body = req.body as RulesSnapshotRequest;

    applyRules({
      version: body.version,
      stackPolicies: body.stackPolicies as Record<string, StackPolicy>,
      defaultUpstream: body.defaultUpstream,
    });

    const state = getState();
    let ruleCount = 0;
    for (const compiled of state.stackPolicies.values()) {
      ruleCount += compiled.policy.rules.length;
    }

    const response: RulesSnapshotResponse = {
      version: state.rulesVersion,
      accepted: true,
      ruleCount,
      stackCount: state.stackPolicies.size,
    };

    logger.info(
      { version: body.version, ruleCount, stackCount: state.stackPolicies.size },
      "admin.rules-applied",
    );

    res.status(200).json(response);
  });

  // ---------------------------------------------------------------------------
  // POST /admin/container-map
  // ---------------------------------------------------------------------------
  app.post("/admin/container-map", (req: Request, res: Response) => {
    const validationError = validateContainerMapRequest(req.body);
    if (validationError) {
      res.status(400).json(validationError satisfies ErrorResponse);
      return;
    }

    const body = req.body as ContainerMapRequest;

    // Filter out non-IPv4 entries and warn.
    const validEntries: ContainerMapEntry[] = [];
    for (const entry of body.entries) {
      if (!isIPv4(entry.ip)) {
        logger.warn(
          { ip: entry.ip, stackId: entry.stackId },
          "Skipping non-IPv4 container map entry",
        );
        continue;
      }
      validEntries.push(entry);
    }

    applyContainerMap({
      version: body.version,
      entries: validEntries,
    });

    const state = getState();
    const response: ContainerMapResponse = {
      version: state.containerMapVersion,
      accepted: true,
      entryCount: state.containerMap.size,
    };

    logger.info(
      { version: body.version, entryCount: state.containerMap.size },
      "admin.container-map-applied",
    );

    res.status(200).json(response);
  });

  // ---------------------------------------------------------------------------
  // GET /admin/health
  // ---------------------------------------------------------------------------
  app.get("/admin/health", (_req: Request, res: Response) => {
    const state = getState();
    const response: HealthResponse = {
      ok: true,
      rulesVersion: state.rulesVersion,
      containerMapVersion: state.containerMapVersion,
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      upstream: {
        servers: config.upstreamDns,
        lastSuccessAt: state.upstreamLastSuccessAt?.toISOString() ?? null,
        lastFailureAt: state.upstreamLastFailureAt?.toISOString() ?? null,
      },
    };
    res.status(200).json(response);
  });

  // ---------------------------------------------------------------------------
  // GET /admin/stats
  // ---------------------------------------------------------------------------
  app.get("/admin/stats", (_req: Request, res: Response) => {
    const state = getState();
    const response: StatsResponse = state.stats;
    res.status(200).json(response);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let adminServer: ReturnType<typeof app.listen> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

export function startAdminServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    app = createAdminApp();
    adminServer = app.listen(config.adminPort, "0.0.0.0", () => {
      logger.info({ port: config.adminPort }, "Admin server listening");
      resolve();
    });
    adminServer?.on("error", reject);
  });
}

export function stopAdminServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!adminServer) {
      resolve();
      return;
    }
    adminServer.close((err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
    adminServer = null;
  });
}
