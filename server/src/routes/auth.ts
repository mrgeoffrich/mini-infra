import { Router, Request, Response, NextFunction } from "express";
import passport from "../lib/passport.js";
import logger from "../lib/logger.js";
import config from "../lib/config.js";
import type { AuthStatus, UserProfile } from "../types/auth.js";

const router = Router();

// Initialize Passport middleware
router.use(passport.initialize());
router.use(passport.session());

// Google OAuth initiation
router.get("/google", (req: Request, res: Response, next: NextFunction) => {
  logger.info("Initiating Google OAuth flow");

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

// OAuth success redirect
router.get("/success", (req: Request, res: Response) => {
  if (!req.user) {
    logger.warn("OAuth success callback reached but no user in session");
    return res.redirect("/auth/failure");
  }

  logger.info({ userId: req.user.id }, "OAuth authentication successful");

  // Redirect to frontend dashboard or appropriate page
  const redirectUrl =
    config.NODE_ENV === "development"
      ? "http://localhost:3000/dashboard"
      : "/dashboard";

  res.redirect(redirectUrl);
});

// OAuth failure redirect
router.get("/failure", (req: Request, res: Response) => {
  logger.warn("OAuth authentication failed");

  // Redirect to frontend login page with error
  const redirectUrl =
    config.NODE_ENV === "development"
      ? "http://localhost:3000/?auth=error"
      : "/?auth=error";

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
