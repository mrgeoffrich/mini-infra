import { Router, Request, Response, RequestHandler } from "express";
import { getLogger } from "../lib/logger-factory";
import prisma from "../lib/prisma";
import { verifyPassword } from "../lib/password-service";
import { createApiKey } from "../lib/api-key-service";

const logger = getLogger("auth", "dev-api-key-route");
const router = Router();

// Gated by ENABLE_DEV_API_KEY_ENDPOINT at registration time. Exchanges admin
// email + password for a full-admin API key. Intended for dev/seed tooling
// that needs to drive the API before a UI session exists.
router.post("/issue-api-key", (async (req: Request, res: Response) => {
  const { email, password, name } = req.body as {
    email?: string;
    password?: string;
    name?: string;
  };

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (!user || !user.passwordHash) {
      logger.warn({ email }, "dev issue-api-key: user not found or no password");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      logger.warn({ userId: user.id }, "dev issue-api-key: bad password");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const keyName =
      name?.trim() ||
      `dev-seed ${new Date().toISOString().replace(/[:.]/g, "-")}`;

    // permissions: null => full access (see parsePermissions in api-key-service.ts)
    const apiKey = await createApiKey(user.id, { name: keyName });

    logger.info(
      { userId: user.id, keyId: apiKey.id, keyName },
      "Dev API key issued",
    );

    return res.status(201).json({
      apiKey: apiKey.key,
      keyId: apiKey.id,
      userId: user.id,
    });
  } catch (error) {
    logger.error({ error }, "Failed to issue dev API key");
    return res.status(500).json({ error: "Failed to issue API key" });
  }
}) as RequestHandler);

export default router;
