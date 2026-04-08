import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import crypto from "crypto";
import Docker from "dockerode";
import os from "os";
import passport from "../lib/passport";
import { appLogger } from "../lib/logger-factory";
import { serverConfig, securityConfig, authConfig } from "../lib/config-new";
import { generateToken } from "../lib/jwt";
import prisma from "../lib/prisma";
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  generateTemporaryPassword,
} from "../lib/password-service";
import {
  checkLockout,
  recordFailedAttempt,
  resetFailedAttempts,
} from "../lib/account-lockout-service";
import * as authSettingsService from "../lib/auth-settings-service";
import { requireAuth } from "../lib/auth-middleware";
import { getApiKeySecret } from "../lib/security-config";
import type {
  AuthStatus,
  UserProfile,
  JWTUser,
  SetupRequest,
  LocalLoginRequest,
  RecoverRequestPayload,
  RecoverResetPayload,
  ChangePasswordRequest,
  DockerSocketDetectionResult,
} from "@mini-infra/types";

const logger = appLogger();
const router = Router();

// Helper function to convert JWTUser to UserProfile for API responses
function serializeUserProfile(user: JWTUser & { mustResetPwd?: boolean }): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    createdAt: user.createdAt.toISOString(),
  };
}

// Cookie helper
function getSecureCookieFlag(): boolean {
  return serverConfig.nodeEnv === "production" && !securityConfig.allowInsecure;
}

function setAuthCookie(res: Response, token: string): void {
  const secure = getSecureCookieFlag();
  res.cookie("auth-token", token, {
    httpOnly: true,
    secure,
    sameSite: secure ? "strict" : "lax",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });
}

// Hash a recovery token (same HMAC approach as API keys)
function hashToken(token: string): string {
  return crypto
    .createHmac("sha256", getApiKeySecret())
    .update(token)
    .digest("hex");
}

// Initialize Passport middleware (without sessions)
router.use(passport.initialize());

// ==========================================
// Public: Setup status
// ==========================================
router.get("/setup-status", (async (_req: Request, res: Response) => {
  try {
    const userCount = await prisma.user.count();
    const setupComplete = userCount > 0 && (await authSettingsService.isSetupComplete());
    const googleOAuthEnabled = await authSettingsService.isGoogleOAuthEnabled();

    res.json({ setupComplete, hasUsers: userCount > 0, googleOAuthEnabled });
  } catch (error) {
    logger.error({ error }, "Error checking setup status");
    res.status(500).json({ error: "Failed to check setup status" });
  }
}) as RequestHandler);

// ==========================================
// Public: First-time setup (create first user)
// ==========================================
router.post("/setup", (async (req: Request, res: Response) => {
  try {
    const { email, displayName, password } = req.body as SetupRequest;

    if (!email || !displayName || !password) {
      return res.status(400).json({ error: "Email, display name, and password are required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Validate password strength
    const strengthCheck = validatePasswordStrength(password);
    if (!strengthCheck.valid) {
      return res.status(400).json({ error: strengthCheck.message });
    }

    // Use a transaction to prevent race conditions
    const result = await prisma.$transaction(async (tx) => {
      const existingUsers = await tx.user.count();
      if (existingUsers > 0) {
        return null; // Signal that setup is already done
      }

      const passwordHash = await hashPassword(password);
      const user = await tx.user.create({
        data: {
          email: email.toLowerCase().trim(),
          name: displayName.trim(),
          passwordHash,
          authMethod: "local",
        },
      });

      return user;
    });

    if (!result) {
      return res.status(403).json({ error: "Setup has already been completed" });
    }

    logger.info({ userId: result.id, email: result.email }, "Initial user created during setup");
    res.status(201).json({ success: true });
  } catch (error) {
    logger.error({ error }, "Error during setup");
    res.status(500).json({ error: "Setup failed" });
  }
}) as RequestHandler);

// ==========================================
// Public: Setup — auto-detect Docker socket
// ==========================================
router.post("/setup/detect-docker", (async (_req: Request, res: Response) => {
  try {
    const userCount = await prisma.user.count();
    const setupComplete = await authSettingsService.isSetupComplete();
    if (userCount === 0 || setupComplete) {
      return res.status(403).json({ error: "Setup is not in progress" });
    }

    const home = os.homedir();
    const candidates = [
      { socketPath: "/var/run/docker.sock", display: "unix:///var/run/docker.sock" },
      { socketPath: "/run/docker.sock", display: "unix:///run/docker.sock" },
      { socketPath: `${home}/.docker/run/docker.sock`, display: `unix://${home}/.docker/run/docker.sock` },
      { socketPath: `${home}/.colima/default/docker.sock`, display: `unix://${home}/.colima/default/docker.sock` },
      { socketPath: `${home}/.orbstack/run/docker.sock`, display: `unix://${home}/.orbstack/run/docker.sock` },
      { socketPath: "//./pipe/docker_engine", display: "npipe:////./pipe/docker_engine" },
    ];

    const sockets: DockerSocketDetectionResult["sockets"] = [];

    for (const candidate of candidates) {
      try {
        const docker = new Docker({ socketPath: candidate.socketPath });
        const ping = await Promise.race([
          docker.ping(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 3000),
          ),
        ]);

        const pingStr =
          ping instanceof Buffer ? ping.toString().trim() :
          typeof ping === "string" ? ping.trim() :
          String(ping).trim();

        if (pingStr.toLowerCase() === "ok" || ping === true) {
          let version: string | undefined;
          try {
            const info = await docker.version();
            version = info.Version;
          } catch { /* version is optional */ }

          sockets.push({
            path: candidate.socketPath,
            displayPath: candidate.display,
            version,
          });
        }
      } catch {
        // Socket not accessible — skip
      }
    }

    const result: DockerSocketDetectionResult = {
      detected: sockets.length > 0,
      sockets,
    };

    res.json(result);
  } catch (error) {
    logger.error({ error }, "Error during Docker socket detection");
    res.status(500).json({ error: "Docker detection failed" });
  }
}) as RequestHandler);

// ==========================================
// Public: Setup — retrieve app secret
// ==========================================
router.get("/setup/app-secret", (async (_req: Request, res: Response) => {
  try {
    const userCount = await prisma.user.count();
    const setupComplete = await authSettingsService.isSetupComplete();
    if (userCount === 0 || setupComplete) {
      return res.status(403).json({ error: "Setup is not in progress" });
    }

    const secretSetting = await prisma.systemSettings.findFirst({
      where: { category: "system", key: "app_secret", isActive: true },
    });

    if (!secretSetting?.value) {
      return res.status(500).json({ error: "App secret not found" });
    }

    res.json({ appSecret: secretSetting.value });
  } catch (error) {
    logger.error({ error }, "Error retrieving app secret");
    res.status(500).json({ error: "Failed to retrieve app secret" });
  }
}) as RequestHandler);

// ==========================================
// Public: Setup — complete setup wizard
// ==========================================
router.post("/setup/complete", (async (req: Request, res: Response) => {
  try {
    const userCount = await prisma.user.count();
    const setupComplete = await authSettingsService.isSetupComplete();
    if (userCount === 0 || setupComplete) {
      return res.status(403).json({ error: "Setup is not in progress" });
    }

    // Optionally save Docker socket configuration
    const { dockerHost } = req.body as { dockerHost?: string };
    if (dockerHost) {
      // Save docker host setting
      await prisma.systemSettings.upsert({
        where: { category_key: { category: "docker", key: "host" } },
        create: {
          category: "docker",
          key: "host",
          value: dockerHost,
          isEncrypted: false,
          isActive: true,
          createdBy: "system",
          updatedBy: "system",
        },
        update: {
          value: dockerHost,
          updatedBy: "system",
          updatedAt: new Date(),
        },
      });
      logger.info({ dockerHost }, "Docker host saved during setup");
    }

    await authSettingsService.markSetupComplete();
    logger.info("Setup wizard completed");
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, "Error completing setup");
    res.status(500).json({ error: "Failed to complete setup" });
  }
}) as RequestHandler);

// ==========================================
// Public: Local login
// ==========================================
router.post("/login", (async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as LocalLoginRequest;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Find user by email (case-insensitive)
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check lockout
    const lockoutStatus = checkLockout(user);
    if (lockoutStatus.locked) {
      return res.status(423).json({
        error: `Account locked. Try again in ${lockoutStatus.remainingMinutes} minute(s).`,
      });
    }

    // Check if user has a password (Google-only users don't)
    if (!user.passwordHash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Verify password
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      await recordFailedAttempt(user.id);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check ALLOWED_ADMIN_EMAILS if configured
    const allowedEmails = authConfig.allowedEmails;
    if (allowedEmails && allowedEmails.length > 0) {
      if (!allowedEmails.includes(user.email.toLowerCase())) {
        logger.warn({ email: user.email }, "Login rejected - email not in ALLOWED_ADMIN_EMAILS list");
        return res.status(403).json({ error: "Email not authorized" });
      }
    }

    // Successful login
    await resetFailedAttempts(user.id);
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const profile: UserProfile = {
      id: user.id,
      email: user.email,
      name: user.name || undefined,
      image: user.image || undefined,
      authMethod: user.authMethod,
      createdAt: user.createdAt.toISOString(),
    };

    const token = generateToken(profile, {
      mustResetPwd: user.mustResetPwd,
    });
    setAuthCookie(res, token);

    logger.info({ userId: user.id }, "Local login successful");
    res.json({ success: true, mustResetPwd: user.mustResetPwd });
  } catch (error) {
    logger.error({ error }, "Error during login");
    res.status(500).json({ error: "Login failed" });
  }
}) as RequestHandler);

// ==========================================
// Public: Password recovery - request token
// ==========================================
router.post("/recover/request", (async (req: Request, res: Response) => {
  try {
    const { email } = req.body as RecoverRequestPayload;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Always return 200 to prevent email enumeration
    const genericResponse = {
      message: "If an account exists with that email, a recovery token has been generated. Check the server logs.",
    };

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (!user) {
      return res.json(genericResponse);
    }

    // Generate token
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Invalidate any existing unused tokens for this user
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    // Store hashed token
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    // Print token to stdout for docker logs
    const separator = "========================================";
    console.log(`\n${separator}`);
    console.log(`PASSWORD RESET TOKEN for ${user.email}`);
    console.log(`Token: ${rawToken}`);
    console.log(`Expires: ${expiresAt.toISOString()}`);
    console.log(`${separator}\n`);

    logger.info({ userId: user.id }, "Password reset token generated");
    res.json(genericResponse);
  } catch (error) {
    logger.error({ error }, "Error generating recovery token");
    res.status(500).json({ error: "Recovery request failed" });
  }
}) as RequestHandler);

// ==========================================
// Public: Password recovery - reset with token
// ==========================================
router.post("/recover/reset", (async (req: Request, res: Response) => {
  try {
    const { email, token, newPassword } = req.body as RecoverResetPayload;

    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: "Email, token, and new password are required" });
    }

    const strengthCheck = validatePasswordStrength(newPassword);
    if (!strengthCheck.valid) {
      return res.status(400).json({ error: strengthCheck.message });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired recovery token" });
    }

    // Find matching token
    const tokenHash = hashToken(token);
    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!resetToken) {
      return res.status(400).json({ error: "Invalid or expired recovery token" });
    }

    // Update password and mark token as used
    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustResetPwd: false,
          failedAttempts: 0,
          lockedUntil: null,
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { used: true },
      }),
    ]);

    logger.info({ userId: user.id }, "Password reset via recovery token");
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, "Error resetting password");
    res.status(500).json({ error: "Password reset failed" });
  }
}) as RequestHandler);

// ==========================================
// Authenticated: Change password
// ==========================================
router.post("/change-password", requireAuth, (async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body as ChangePasswordRequest;
    const userId = req.user!.id;

    if (!newPassword) {
      return res.status(400).json({ error: "New password is required" });
    }

    const strengthCheck = validatePasswordStrength(newPassword);
    if (!strengthCheck.valid) {
      return res.status(400).json({ error: strengthCheck.message });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // If not forced reset, verify current password
    if (!user.mustResetPwd) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Current password is required" });
      }
      if (!user.passwordHash) {
        return res.status(400).json({ error: "No password set on this account" });
      }
      const valid = await verifyPassword(user.passwordHash, currentPassword);
      if (!valid) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustResetPwd: false,
      },
    });

    // Issue a fresh JWT without mustResetPwd
    const profile: UserProfile = {
      id: user.id,
      email: user.email,
      name: user.name || undefined,
      image: user.image || undefined,
      authMethod: user.authMethod,
      createdAt: user.createdAt.toISOString(),
    };
    const token = generateToken(profile);
    setAuthCookie(res, token);

    logger.info({ userId }, "Password changed successfully");
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, "Error changing password");
    res.status(500).json({ error: "Password change failed" });
  }
}) as RequestHandler);

// ==========================================
// Google OAuth (conditional)
// ==========================================
router.get("/google", (async (req: Request, res: Response, next: NextFunction) => {
  // Check if Google OAuth is enabled
  const enabled = await authSettingsService.isGoogleOAuthEnabled();
  if (!enabled) {
    return res.redirect("/login?auth=google-not-enabled");
  }

  const credentials = await authSettingsService.getGoogleCredentials();
  if (!credentials) {
    return res.redirect("/login?auth=google-not-configured");
  }

  // Dynamically configure Google strategy
  const { configureGoogleStrategy } = await import("../lib/passport");
  configureGoogleStrategy(credentials.clientId, credentials.clientSecret);

  const redirectParam = req.query.redirect as string;
  logger.debug({ redirect: redirectParam }, "Initiating Google OAuth flow");

  const nonce = crypto.randomBytes(32).toString("hex");
  let redirectPath = "";
  if (
    redirectParam &&
    redirectParam.startsWith("/") &&
    !redirectParam.startsWith("//") &&
    !redirectParam.includes("://")
  ) {
    redirectPath = redirectParam;
  }

  const statePayload = JSON.stringify({ nonce, redirect: redirectPath });
  const state = Buffer.from(statePayload).toString("base64");

  const secure = getSecureCookieFlag();
  res.cookie("oauth-state", nonce, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: 5 * 60 * 1000,
    path: "/auth/google/callback",
  });

  passport.authenticate("google", {
    scope: ["profile", "email"],
    state,
  })(req, res, next);
}) as RequestHandler);

router.get("/google/callback", ((req: Request, res: Response, next: NextFunction) => {
  passport.authenticate("google", (err: any, user: any) => {
    const storedNonce = req.cookies?.["oauth-state"];
    res.clearCookie("oauth-state", { path: "/auth/google/callback" });

    if (err || !user) {
      logger.error({ error: err }, "OAuth authentication error");
      return res.redirect("/auth/failure");
    }

    if (!storedNonce) {
      logger.warn("OAuth callback missing oauth-state cookie");
      return res.redirect("/auth/failure");
    }

    let stateNonce: string | undefined;
    let stateRedirect: string | undefined;
    try {
      const stateRaw = req.query.state as string;
      if (stateRaw) {
        const parsed = JSON.parse(Buffer.from(stateRaw, "base64").toString("utf8"));
        stateNonce = parsed.nonce;
        stateRedirect = parsed.redirect;
      }
    } catch {
      logger.warn("Failed to parse OAuth state parameter");
      return res.redirect("/auth/failure");
    }

    const nonceBuf = Buffer.from(stateNonce || "");
    const storedBuf = Buffer.from(storedNonce);
    if (
      !stateNonce ||
      nonceBuf.length !== storedBuf.length ||
      !crypto.timingSafeEqual(nonceBuf, storedBuf)
    ) {
      logger.warn("OAuth state nonce mismatch");
      return res.redirect("/auth/failure");
    }

    try {
      const profile: UserProfile = {
        id: user.id,
        email: user.email,
        name: user.name || undefined,
        image: user.image || undefined,
        createdAt: user.createdAt.toISOString(),
      };
      const token = generateToken(profile);

      let redirectPath = "/dashboard";
      if (
        stateRedirect &&
        stateRedirect.startsWith("/") &&
        !stateRedirect.startsWith("//") &&
        !stateRedirect.includes("://")
      ) {
        redirectPath = stateRedirect;
      }

      const frontendUrl =
        serverConfig.publicUrl ||
        (serverConfig.nodeEnv === "development" ? "http://localhost:3000" : "");

      setAuthCookie(res, token);
      res.redirect(`${frontendUrl}${redirectPath}`);
    } catch (error) {
      logger.error({ error }, "Error generating JWT after OAuth");
      return res.redirect("/auth/failure");
    }
  })(req, res, next);
}) as RequestHandler);

// OAuth failure redirect
router.get("/failure", ((req: Request, res: Response) => {
  const frontendUrl =
    serverConfig.publicUrl ||
    (serverConfig.nodeEnv === "development" ? "http://localhost:3000" : "");
  res.redirect(`${frontendUrl}/login?auth=error`);
}) as RequestHandler);

// ==========================================
// Logout
// ==========================================
router.post("/logout", ((req: Request, res: Response) => {
  try {
    const secure = getSecureCookieFlag();
    res.clearCookie("auth-token", {
      httpOnly: true,
      secure,
      sameSite: secure ? "strict" : "lax",
    });
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    logger.error({ error }, "Error during logout");
    res.status(500).json({ error: "Logout failed" });
  }
}) as RequestHandler);

// ==========================================
// Auth status
// ==========================================
router.get("/status", ((req: Request, res: Response) => {
  if (req.user) {
    const response: AuthStatus = {
      isAuthenticated: true,
      user: serializeUserProfile(req.user),
      mustResetPwd: req.user.mustResetPwd || false,
    };
    res.json(response);
  } else {
    const response: AuthStatus = {
      isAuthenticated: false,
      user: null,
    };
    res.json(response);
  }
}) as RequestHandler);

// Get current user profile
router.get("/user", ((req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  res.json(serializeUserProfile(req.user));
}) as RequestHandler);

export default router;
