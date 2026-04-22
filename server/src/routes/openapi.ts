import express, { Request, Response, RequestHandler } from "express";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { requirePermission } from "../middleware/auth";
import { openApiRegistry } from "../lib/openapi-registry";

const router = express.Router();

/**
 * GET /api/openapi.json
 * Emits the OpenAPI 3.1 document assembled from every describeRoute() call.
 * Gated by agent:use so the agent sidecar can consume it without widening
 * exposure to unauthenticated callers.
 */
router.get(
  "/",
  requirePermission("agent:use") as RequestHandler,
  (_req: Request, res: Response) => {
    const generator = new OpenApiGeneratorV31(openApiRegistry.definitions);
    const doc = generator.generateDocument({
      openapi: "3.1.0",
      info: {
        title: "Mini Infra API",
        version: process.env.BUILD_VERSION || "dev",
        description:
          "Machine-readable surface for Mini Infra's REST API. Coverage grows as routes migrate to describeRoute().",
      },
      servers: [{ url: "/" }],
    });
    res.json(doc);
  },
);

export default router;
