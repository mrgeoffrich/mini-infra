import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import crypto from "crypto";
import passport from "../lib/passport";
import { appLogger } from "../lib/logger-factory";
import { serverConfig, securityConfig } from "../lib/config-new";
import { generateToken } from "../lib/jwt";
import type { AuthStatus, UserProfile, JWTUser } from "@mini-infra/types";

// Use app logger for authentication routes
const logger = appLogger();

const router = Router();

// Helper function to convert JWTUser to UserProfile for API responses
function serializeUserProfile(user: JWTUser): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    createdAt: user.createdAt.toISOString(),
  };
}

// Initialize Passport middleware (without sessions)
router.use(passport.initialize());


// Google OAuth initiation
router.get("/google", ((req: Request, res: Response, next: NextFunction) => {
  const redirectParam = req.query.redirect as string;
  logger.debug({ redirect: redirectParam }, "Initiating Google OAuth flow");

  // Generate a cryptographic nonce to prevent OAuth CSRF (login CSRF / account confusion)
  const nonce = crypto.randomBytes(32).toString("hex");

  // Build state payload: nonce + optional redirect path
  let redirectPath = "";
  if (redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//") && !redirectParam.includes("://")) {
    redirectPath = redirectParam;
  } else if (redirectParam) {
    logger.warn({ redirect: redirectParam }, "Rejected unsafe redirect parameter in OAuth initiation");
  }

  const statePayload = JSON.stringify({ nonce, redirect: redirectPath });
  const state = Buffer.from(statePayload).toString("base64");

  // Store nonce in a short-lived HTTP-only cookie for verification on callback
  const shouldUseSecureCookie = serverConfig.nodeEnv === "production" && !securityConfig.allowInsecure;
  res.cookie("oauth-state", nonce, {
    httpOnly: true,
    secure: shouldUseSecureCookie,
    sameSite: "lax",
    maxAge: 5 * 60 * 1000, // 5 minutes — generous for the OAuth round-trip
    path: "/auth/google/callback",
  });

  passport.authenticate("google", {
    scope: ["profile", "email"],
    state,
  })(req, res, next);
}) as RequestHandler);


// Google OAuth callback
router.get("/google/callback", ((
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  passport.authenticate("google", (err: any, user: any, info: any) => {
    // Read the nonce cookie before clearing it
    const storedNonce = req.cookies?.["oauth-state"];
    // Always clear the oauth-state cookie regardless of outcome
    res.clearCookie("oauth-state", { path: "/auth/google/callback" });

    if (err) {
      logger.error({ error: err }, "OAuth authentication error");
      return res.redirect("/auth/failure");
    }

    if (!user) {
      logger.warn({ info }, "OAuth authentication failed - no user returned");
      return res.redirect("/auth/failure");
    }

    // Verify the CSRF nonce from the state parameter against the cookie
    if (!storedNonce) {
      logger.warn("OAuth callback missing oauth-state cookie — possible CSRF");
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
    if (!stateNonce || nonceBuf.length !== storedBuf.length || !crypto.timingSafeEqual(nonceBuf, storedBuf)) {
      logger.warn("OAuth state nonce mismatch — possible CSRF attack");
      return res.redirect("/auth/failure");
    }

    // Generate JWT token immediately
    try {
      const token = generateToken(user as UserProfile);

      logger.debug(
        { userId: user.id },
        "OAuth authentication successful, JWT token generated",
      );

      // Get the redirect URL from state parameter or use default
      const frontendUrl =
        serverConfig.publicUrl ||
        (serverConfig.nodeEnv === "development" ? "http://localhost:3000" : "");

      let redirectPath = "/dashboard";
      if (stateRedirect && stateRedirect.startsWith("/") && !stateRedirect.startsWith("//") && !stateRedirect.includes("://")) {
        redirectPath = stateRedirect;
      }

      const redirectUrl = `${frontendUrl}${redirectPath}`;

      // Set JWT token as HTTP-only cookie
      // Only set secure flag if in production AND not explicitly allowing insecure connections
      const shouldUseSecureCookie = serverConfig.nodeEnv === "production" && !securityConfig.allowInsecure;
      res.cookie("auth-token", token, {
        httpOnly: true,
        secure: shouldUseSecureCookie,
        sameSite: shouldUseSecureCookie ? "strict" : "lax",
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      });

      logger.debug(
        { redirectUrl },
        "Redirecting after successful OAuth with JWT cookie",
      );
      res.redirect(redirectUrl);
    } catch (error) {
      logger.error(
        { error, userId: user.id },
        "Error generating JWT token after OAuth",
      );
      return res.redirect("/auth/failure");
    }
  })(req, res, next);
}) as RequestHandler);


// OAuth failure redirect
router.get("/failure", ((req: Request, res: Response) => {
  logger.warn("OAuth authentication failed");

  // Redirect to frontend login page with error
  const frontendUrl =
    serverConfig.publicUrl ||
    (serverConfig.nodeEnv === "development" ? "http://localhost:3000" : "");
  const redirectUrl = `${frontendUrl}/login?auth=error`;

  logger.debug({ redirectUrl }, "Redirecting after failed OAuth");
  res.redirect(redirectUrl);
}) as RequestHandler);


// Logout endpoint
router.post("/logout", ((req: Request, res: Response) => {
  const userId = req.user ? req.user.id : "unknown";

  try {
    // Clear the JWT token cookie
    // Match the same cookie options as when it was set
    const shouldUseSecureCookie = serverConfig.nodeEnv === "production" && !securityConfig.allowInsecure;
    res.clearCookie("auth-token", {
      httpOnly: true,
      secure: shouldUseSecureCookie,
      sameSite: shouldUseSecureCookie ? "strict" : "lax",
    });

    logger.debug({ userId }, "User logged out successfully");
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    logger.error({ error, userId }, "Error during logout");
    res.status(500).json({ error: "Logout failed" });
  }
}) as RequestHandler);


router.get("/status", ((req: Request, res: Response) => {
  if (req.user) {
    logger.debug(
      { userId: req.user.id },
      "Authentication status check - authenticated",
    );

    const response: AuthStatus = {
      isAuthenticated: true,
      user: serializeUserProfile(req.user),
    };

    res.json(response);
  } else {
    logger.debug("Authentication status check - not authenticated");

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
    logger.debug("User profile request - not authenticated");
    return res.status(401).json({ error: "Not authenticated" });
  }

  logger.debug({ userId: req.user.id }, "User profile request");

  const userProfile = serializeUserProfile(req.user);

  res.json(userProfile);
}) as RequestHandler);

export default router;
