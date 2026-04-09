import { Router, Request, Response, RequestHandler } from "express";
import prisma from "../lib/prisma";
import { appLogger } from "../lib/logger-factory";
import { requireAuth } from "../lib/auth-middleware";
import {
  hashPassword,
  generateTemporaryPassword,
  validatePasswordStrength,
} from "../lib/password-service";
import type { CreateUserRequest, UserInfo } from "@mini-infra/types";

const logger = appLogger();
const router = Router();

// All routes require authentication
router.use(requireAuth as RequestHandler);

// List all users
router.get("/", (async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        authMethod: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const result: UserInfo[] = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      authMethod: u.authMethod,
      createdAt: u.createdAt.toISOString(),
    }));

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ error }, "Error listing users");
    res.status(500).json({ error: "Failed to list users" });
  }
}) as RequestHandler);

// Create a new user
router.post("/", (async (req: Request, res: Response) => {
  try {
    const { email, displayName, password } = req.body as CreateUserRequest;

    if (!email || !displayName || !password) {
      return res.status(400).json({ error: "Email, display name, and password are required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const strengthCheck = validatePasswordStrength(password);
    if (!strengthCheck.valid) {
      return res.status(400).json({ error: strengthCheck.message });
    }

    // Check uniqueness
    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (existing) {
      return res.status(409).json({ error: "A user with this email already exists" });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        name: displayName.trim(),
        passwordHash,
        authMethod: "local",
        mustResetPwd: true,
      },
    });

    logger.info({ userId: user.id, email: user.email, createdBy: req.user!.id }, "User created");

    const result: UserInfo = {
      id: user.id,
      email: user.email,
      name: user.name,
      authMethod: user.authMethod,
      createdAt: user.createdAt.toISOString(),
    };

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    logger.error({ error }, "Error creating user");
    res.status(500).json({ error: "Failed to create user" });
  }
}) as RequestHandler);

// Delete a user
router.delete("/:id", (async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    if (id === req.user!.id) {
      return res.status(400).json({ error: "You cannot delete your own account" });
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.user.delete({ where: { id } });

    logger.info({ userId: id, deletedBy: req.user!.id }, "User deleted");
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, "Error deleting user");
    res.status(500).json({ error: "Failed to delete user" });
  }
}) as RequestHandler);

// Reset a user's password (admin action)
router.post("/:id/reset-password", (async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    await prisma.user.update({
      where: { id },
      data: {
        passwordHash,
        mustResetPwd: true,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });

    logger.info({ userId: id, resetBy: req.user!.id }, "User password reset by admin");

    res.json({ success: true, data: { temporaryPassword } });
  } catch (error) {
    logger.error({ error }, "Error resetting user password");
    res.status(500).json({ error: "Failed to reset password" });
  }
}) as RequestHandler);

export default router;
