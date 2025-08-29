import { Router, Request, Response, NextFunction } from "express";
import passport from "../lib/passport";
import logger from "../lib/logger";
import config from "../lib/config";
import { regenerateSession } from "../lib/session-middleware";
import type { AuthStatus, UserProfile } from "../types/auth";

const router = Router();

// Initialize Passport middleware
router.use(passport.initialize());
router.use(passport.session());

// Google OAuth initiation
router.get("/google", (req: Request, res: Response, next: NextFunction) => {
  const redirectParam = req.query.redirect as string;
  logger.info({ redirect: redirectParam }, "Initiating Google OAuth flow");

  // Store redirect URL in session for later use
  if (redirectParam) {
    req.session.oauthRedirect = redirectParam;
  }

  passport.authenticate("google", {
    scope: ["profile", "email"],
  })(req, res, next);
});

// Google OAuth callback
router.get(
  "/google/callback",
  (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate("google", {
      successRedirect: "/auth/success",
      failureRedirect: "/auth/failure",
    })(req, res, next);
  },
);

// OAuth success redirect with session regeneration
router.get("/success", async (req: Request, res: Response) => {
  if (!req.user) {
    logger.warn("OAuth success callback reached but no user in session");
    return res.redirect("/auth/failure");
  }

  try {
    // Regenerate session for security (prevent session fixation)
    await regenerateSession(req);

    logger.info(
      { userId: req.user.id },
      "OAuth authentication successful, session regenerated",
    );

    // Get the redirect URL from session (stored during OAuth initiation) or use default
    const frontendUrl =
      config.NODE_ENV === "development" ? "http://localhost:3000" : "";
    const redirectPath = req.session.oauthRedirect || "/dashboard";
    const redirectUrl = `${frontendUrl}${redirectPath}`;

    // Clear the stored redirect from session
    delete req.session.oauthRedirect;

    logger.info(
      { redirectUrl, originalQuery: req.query },
      "Redirecting after successful OAuth",
    );
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error(
      { error, userId: req.user.id },
      "Error regenerating session after OAuth",
    );
    return res.redirect("/auth/failure");
  }
});

// OAuth failure redirect
router.get("/failure", (req: Request, res: Response) => {
  logger.warn("OAuth authentication failed");

  // Redirect to frontend login page with error
  const frontendUrl =
    config.NODE_ENV === "development" ? "http://localhost:3000" : "";
  const redirectUrl = `${frontendUrl}/login?auth=error`;

  logger.info({ redirectUrl }, "Redirecting after failed OAuth");
  res.redirect(redirectUrl);
});

// Logout endpoint
router.post("/logout", (req: Request, res: Response) => {
  const userId = req.user ? req.user.id : "unknown";

  req.logout((err) => {
    if (err) {
      logger.error({ error: err, userId }, "Error during logout");
      return res.status(500).json({ error: "Logout failed" });
    }

    logger.info({ userId }, "User logged out successfully");
    res.json({ message: "Logged out successfully" });
  });
});

// Get current user status
router.get("/status", (req: Request, res: Response) => {
  if (req.user) {
    logger.debug(
      { userId: req.user.id },
      "Authentication status check - authenticated",
    );

    const response: AuthStatus = {
      authenticated: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        image: req.user.image,
        createdAt: req.user.createdAt,
      },
    };

    res.json(response);
  } else {
    logger.debug("Authentication status check - not authenticated");

    const response: AuthStatus = {
      authenticated: false,
      user: null,
    };

    res.json(response);
  }
});

// Get current user profile
router.get("/user", (req: Request, res: Response) => {
  if (!req.user) {
    logger.debug("User profile request - not authenticated");
    return res.status(401).json({ error: "Not authenticated" });
  }

  logger.debug({ userId: req.user.id }, "User profile request");

  const userProfile: UserProfile = {
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    image: req.user.image,
    createdAt: req.user.createdAt,
  };

  res.json(userProfile);
});

export default router;
