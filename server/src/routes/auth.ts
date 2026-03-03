import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
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

  // Store redirect URL in query state for OAuth callback
  // Only encode safe relative paths to prevent open redirect via state parameter
  let state = "";
  if (redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//") && !redirectParam.includes("://")) {
    state = Buffer.from(redirectParam).toString("base64");
  } else if (redirectParam) {
    logger.warn({ redirect: redirectParam }, "Rejected unsafe redirect parameter in OAuth initiation");
  }

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
    if (err) {
      logger.error({ error: err }, "OAuth authentication error");
      return res.redirect("/auth/failure");
    }

    if (!user) {
      logger.warn({ info }, "OAuth authentication failed - no user returned");
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
      try {
        const state = req.query.state as string;
        if (state) {
          const decoded = Buffer.from(state, "base64").toString("utf8");
          // Validate the decoded path is a safe relative path to prevent open redirects
          // Must start with "/" but not "//" (protocol-relative URL), and must not contain "://" (absolute URL)
          if (decoded.startsWith("/") && !decoded.startsWith("//") && !decoded.includes("://")) {
            redirectPath = decoded;
          } else {
            logger.warn({ decoded }, "Rejected unsafe redirect path from OAuth state");
          }
        }
      } catch {
        logger.warn("Failed to decode redirect state, using default");
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
