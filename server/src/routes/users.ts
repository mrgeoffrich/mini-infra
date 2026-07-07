import { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { getLogger } from "../lib/logger-factory";
import { requireAuth } from "../lib/auth-middleware";
import { asyncHandler } from "../lib/async-handler";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import {
  hashPassword,
  generateTemporaryPassword,
  validatePasswordStrength,
} from "../lib/password-service";
import { ErrorCode } from "@mini-infra/types";
import type { UserInfo } from "@mini-infra/types";

const logger = getLogger("auth", "users");
const router = Router();

// All routes require authentication
router.use(requireAuth as RequestHandler);

const createUserSchema = z.object({
  email: z.string().min(1, "Email is required").email("Invalid email format"),
  displayName: z.string().min(1, "Display name is required"),
  password: z.string().min(1, "Password is required"),
});

function userNotFound(id: string): NotFoundError {
  return new NotFoundError(
    ErrorCode.USER_NOT_FOUND,
    `User '${id}' not found.`,
    {
      resource: { type: "user", id },
      action: "Check the user id and try again.",
    },
  );
}

// List all users
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
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
  }),
);

// Create a new user
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    const { email, displayName, password } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const strengthCheck = validatePasswordStrength(password);
    if (!strengthCheck.valid) {
      throw new ValidationError(
        ErrorCode.AUTH_PASSWORD_TOO_WEAK,
        strengthCheck.message ??
          "Password does not meet strength requirements.",
      );
    }

    // Check uniqueness
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictError(
        ErrorCode.USER_EMAIL_EXISTS,
        `A user with email '${normalizedEmail}' already exists.`,
        {
          resource: { type: "user", name: normalizedEmail },
          action: "Use a different email address.",
        },
      );
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: displayName.trim(),
        passwordHash,
        authMethod: "local",
        mustResetPwd: true,
      },
    });

    logger.info(
      { userId: user.id, email: user.email, createdBy: req.user!.id },
      "User created",
    );

    const result: UserInfo = {
      id: user.id,
      email: user.email,
      name: user.name,
      authMethod: user.authMethod,
      createdAt: user.createdAt.toISOString(),
    };

    res.status(201).json({ success: true, data: result });
  }),
);

// Delete a user
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    if (id === req.user!.id) {
      throw new ValidationError(
        ErrorCode.USER_SELF_DELETE_FORBIDDEN,
        "You cannot delete your own account.",
        { action: "Ask another admin to delete this account." },
      );
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw userNotFound(id);
    }

    await prisma.user.delete({ where: { id } });

    logger.info({ userId: id, deletedBy: req.user!.id }, "User deleted");
    res.json({ success: true });
  }),
);

// Reset a user's password (admin action)
router.post(
  "/:id/reset-password",
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw userNotFound(id);
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

    logger.info(
      { userId: id, resetBy: req.user!.id },
      "User password reset by admin",
    );

    res.json({ success: true, data: { temporaryPassword } });
  }),
);

export default router;
