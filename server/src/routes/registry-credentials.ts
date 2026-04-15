import express from "express";
import { z } from "zod";
import { requirePermission, getCurrentUserId } from "../middleware/auth";
import { getLogger } from "../lib/logger-factory";
import prisma from "../lib/prisma";
import {
  RegistryCredentialService,
} from "../services/registry-credential";

type RegistryCredentialsRouterOptions = {
  logger?: ReturnType<typeof getLogger>;
  registryCredentialService?: RegistryCredentialService;
};

// Validation schemas
const createSchema = z.object({
  name: z.string().min(1, "Name is required"),
  registryUrl: z.string().min(1, "Registry URL is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional(),
});

const testConnectionSchema = z.object({
  registryUrl: z.string().min(1, "Registry URL is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  testImage: z.string().optional(),
});

export default function createRegistryCredentialsRouter(
  options: RegistryCredentialsRouterOptions = {},
) {
  const logger = options.logger ?? getLogger("docker", "registry-credentials");
  const registryCredentialService =
    options.registryCredentialService ??
    new RegistryCredentialService(prisma);
  const router = express.Router();

  // GET /api/registry-credentials
  router.get("/", requirePermission("registry:read"), async (req, res) => {
    try {
      const includeInactive = req.query.includeInactive === "true";
      const credentials =
        await registryCredentialService.getAllCredentials(includeInactive);

      const sanitized = credentials.map((cred: (typeof credentials)[number]) => ({
        ...cred,
        password: undefined,
      }));

      res.json({ success: true, data: sanitized });
    } catch (error) {
      logger.error({ error }, "Failed to fetch registry credentials");
      res
        .status(500)
        .json({ success: false, error: "Failed to fetch credentials" });
    }
  });

  router.get("/:id", requirePermission("registry:read"), async (req, res) => {
    try {
      const credential = await registryCredentialService.getCredential(
        String(req.params.id),
      );

      if (!credential) {
        return res
          .status(404)
          .json({ success: false, error: "Credential not found" });
      }

      res.json({
        success: true,
        data: { ...credential, password: undefined },
      });
    } catch (error) {
      logger.error({ error, id: req.params.id }, "Failed to fetch credential");
      res
        .status(500)
        .json({ success: false, error: "Failed to fetch credential" });
    }
  });

  router.post("/", requirePermission("registry:write"), async (req, res) => {
    try {
      const validatedData = createSchema.parse(req.body);
      const userId = getCurrentUserId(req);

      if (!userId) {
        return res
          .status(401)
          .json({ success: false, error: "User not authenticated" });
      }

      const credential = await registryCredentialService.createCredential(
        validatedData,
        userId,
      );

      logger.info(
        { credentialId: credential.id, userId },
        "Registry credential created via API",
      );

      res.status(201).json({
        success: true,
        data: { ...credential, password: undefined },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: error.issues,
        });
      }
      logger.error({ error }, "Failed to create registry credential");
      res
        .status(500)
        .json({ success: false, error: "Failed to create credential" });
    }
  });

  router.put("/:id", requirePermission("registry:write"), async (req, res) => {
    try {
      const validatedData = updateSchema.parse(req.body);
      const userId = getCurrentUserId(req);

      if (!userId) {
        return res
          .status(401)
          .json({ success: false, error: "User not authenticated" });
      }

      const credential = await registryCredentialService.updateCredential(
        String(req.params.id),
        validatedData,
        userId,
      );

      logger.info(
        { credentialId: credential.id, userId },
        "Registry credential updated via API",
      );

      res.json({
        success: true,
        data: { ...credential, password: undefined },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: error.issues,
        });
      }
      logger.error({ error, id: req.params.id }, "Failed to update credential");
      res
        .status(500)
        .json({ success: false, error: "Failed to update credential" });
    }
  });

  router.delete("/:id", requirePermission("registry:write"), async (req, res) => {
    try {
      await registryCredentialService.deleteCredential(String(req.params.id));

      logger.info(
        { credentialId: req.params.id },
        "Registry credential deleted via API",
      );

      res.json({ success: true });
    } catch (error) {
      logger.error({ error, id: req.params.id }, "Failed to delete credential");
      res
        .status(500)
        .json({ success: false, error: "Failed to delete credential" });
    }
  });

  router.post("/:id/set-default", requirePermission("registry:write"), async (req, res) => {
    try {
      await registryCredentialService.setDefaultCredential(String(req.params.id));

      logger.info(
        { credentialId: req.params.id },
        "Registry credential set as default via API",
      );

      res.json({ success: true });
    } catch (error) {
      logger.error(
        { error, id: req.params.id },
        "Failed to set default credential",
      );
      res
        .status(500)
        .json({ success: false, error: "Failed to set default credential" });
    }
  });

  router.post("/:id/test", requirePermission("registry:write"), async (req, res) => {
    try {
      const testImage = req.body?.testImage;

      const result = await registryCredentialService.validateCredential(
        String(req.params.id),
        testImage,
      );

      logger.info(
        { credentialId: req.params.id, success: result.success, testImage },
        "Registry credential tested via API",
      );

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error({ error, id: req.params.id }, "Failed to test credential");
      res
        .status(500)
        .json({ success: false, error: "Failed to test credential" });
    }
  });

  router.post("/test-connection", requirePermission("registry:write"), async (req, res) => {
    try {
      const validatedData = testConnectionSchema.parse(req.body);

      const result = await registryCredentialService.testCredential(
        validatedData.registryUrl,
        validatedData.username,
        validatedData.password,
        validatedData.testImage,
      );

      logger.info(
        { registryUrl: validatedData.registryUrl, success: result.success },
        "Registry connection tested via API",
      );

      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: error.issues,
        });
      }
      logger.error({ error }, "Failed to test registry connection");
      res
        .status(500)
        .json({ success: false, error: "Failed to test connection" });
    }
  });

  return router;
}
