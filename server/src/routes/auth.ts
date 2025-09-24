import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import passport from "../lib/passport";
import { appLogger } from "../lib/logger-factory";
import { serverConfig } from "../lib/config-new";
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

/**
 * @swagger
 * /auth/google:
 *   get:
 *     summary: Initiate Google OAuth authentication
 *     description: Redirects the user to Google OAuth for authentication. Optionally accepts a redirect URL to return to after successful authentication.
 *     tags:
 *       - Authentication
 *     parameters:
 *       - name: redirect
 *         in: query
 *         description: URL path to redirect to after successful authentication (will be base64 encoded in state parameter)
 *         required: false
 *         schema:
 *           type: string
 *           example: '/dashboard'
 *     responses:
 *       302:
 *         description: Redirect to Google OAuth authorization URL
 *         headers:
 *           Location:
 *             description: Google OAuth authorization URL
 *             schema:
 *               type: string
 *               example: 'https://accounts.google.com/oauth/authorize?...'
 *       500:
 *         description: OAuth configuration error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *     security: []
 */
// Google OAuth initiation
router.get("/google", ((req: Request, res: Response, next: NextFunction) => {
  const redirectParam = req.query.redirect as string;
  logger.debug({ redirect: redirectParam }, "Initiating Google OAuth flow");

  // Store redirect URL in query state for OAuth callback
  const state = redirectParam
    ? Buffer.from(redirectParam).toString("base64")
    : "";

  passport.authenticate("google", {
    scope: ["profile", "email"],
    state,
  })(req, res, next);
}) as RequestHandler);

/**
 * @swagger
 * /auth/google/callback:
 *   get:
 *     summary: Handle Google OAuth callback
 *     description: Processes the OAuth callback from Google, validates the authorization code, creates or updates the user account, generates a JWT token, and redirects to the frontend with the token set as an HTTP-only cookie.
 *     tags:
 *       - Authentication
 *     parameters:
 *       - name: code
 *         in: query
 *         description: Authorization code from Google OAuth
 *         required: true
 *         schema:
 *           type: string
 *       - name: state
 *         in: query
 *         description: Base64 encoded redirect URL from the initial OAuth request
 *         required: false
 *         schema:
 *           type: string
 *       - name: error
 *         in: query
 *         description: Error parameter if OAuth failed
 *         required: false
 *         schema:
 *           type: string
 *           example: 'access_denied'
 *     responses:
 *       302:
 *         description: Redirect after successful or failed authentication
 *         headers:
 *           Location:
 *             description: Redirect URL - frontend dashboard on success, login page with error on failure
 *             schema:
 *               type: string
 *               example: 'http://localhost:3000/dashboard'
 *           Set-Cookie:
 *             description: JWT authentication token (HTTP-only cookie, set only on successful auth)
 *             schema:
 *               type: string
 *               example: 'auth-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400'
 *       500:
 *         description: Internal server error during authentication processing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *     security: []
 */
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
          redirectPath = Buffer.from(state, "base64").toString("utf8");
        }
      } catch {
        logger.warn("Failed to decode redirect state, using default");
      }

      const redirectUrl = `${frontendUrl}${redirectPath}`;

      // Set JWT token as HTTP-only cookie
      res.cookie("auth-token", token, {
        httpOnly: true,
        secure: serverConfig.nodeEnv === "production",
        sameSite: serverConfig.nodeEnv === "production" ? "strict" : "lax",
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

/**
 * @swagger
 * /auth/failure:
 *   get:
 *     summary: Handle OAuth authentication failure
 *     description: Handles failed OAuth authentication by redirecting to the frontend login page with an error parameter.
 *     tags:
 *       - Authentication
 *     responses:
 *       302:
 *         description: Redirect to frontend login page with error parameter
 *         headers:
 *           Location:
 *             description: Frontend login URL with auth=error query parameter
 *             schema:
 *               type: string
 *               example: 'http://localhost:3000/login?auth=error'
 *     security: []
 */
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

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout user
 *     description: Logs out the current user by clearing the JWT authentication cookie. This endpoint works regardless of authentication status.
 *     tags:
 *       - Authentication
 *     responses:
 *       200:
 *         description: Logout successful
 *         headers:
 *           Set-Cookie:
 *             description: Clears the auth-token cookie
 *             schema:
 *               type: string
 *               example: 'auth-token=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: 'Logged out successfully'
 *               required:
 *                 - message
 *       500:
 *         description: Logout failed due to server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: 'Logout failed'
 *               required:
 *                 - error
 *     security: []
 */
// Logout endpoint
router.post("/logout", ((req: Request, res: Response) => {
  const userId = req.user ? req.user.id : "unknown";

  try {
    // Clear the JWT token cookie
    res.clearCookie("auth-token", {
      httpOnly: true,
      secure: serverConfig.nodeEnv === "production",
      sameSite: serverConfig.nodeEnv === "production" ? "strict" : "lax",
    });

    logger.debug({ userId }, "User logged out successfully");
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    logger.error({ error, userId }, "Error during logout");
    res.status(500).json({ error: "Logout failed" });
  }
}) as RequestHandler);

/**
 * @swagger
 * /auth/status:
 *   get:
 *     summary: Get authentication status
 *     description: Check if the current user is authenticated and get basic user info
 *     tags:
 *       - Authentication
 *     responses:
 *       200:
 *         description: Authentication status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isAuthenticated:
 *                   type: boolean
 *                   description: Whether the user is authenticated
 *                 user:
 *                   oneOf:
 *                     - type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           description: User ID
 *                         email:
 *                           type: string
 *                           format: email
 *                           description: User email address
 *                         name:
 *                           type: string
 *                           description: User display name
 *                         image:
 *                           type: string
 *                           nullable: true
 *                           description: User profile image URL
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *                           description: Account creation timestamp
 *                     - type: null
 *               required:
 *                 - isAuthenticated
 *                 - user
 *             examples:
 *               authenticated:
 *                 summary: Authenticated user
 *                 value:
 *                   isAuthenticated: true
 *                   user:
 *                     id: "123e4567-e89b-12d3-a456-426614174000"
 *                     email: "user@example.com"
 *                     name: "John Doe"
 *                     image: "https://example.com/avatar.jpg"
 *                     createdAt: "2025-09-24T11:59:00.000Z"
 *               unauthenticated:
 *                 summary: Unauthenticated user
 *                 value:
 *                   isAuthenticated: false
 *                   user: null
 *     security: []
 */
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

/**
 * @swagger
 * /auth/user:
 *   get:
 *     summary: Get current user profile
 *     description: Retrieves the profile information for the currently authenticated user. Requires valid JWT token.
 *     tags:
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *       - ApiKeyAuthBearer: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *             example:
 *               id: '123e4567-e89b-12d3-a456-426614174000'
 *               email: 'user@example.com'
 *               name: 'John Doe'
 *               image: 'https://example.com/avatar.jpg'
 *               createdAt: '2025-09-24T11:59:00.000Z'
 *               updatedAt: '2025-09-24T12:00:00.000Z'
 *       401:
 *         description: User not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: 'Not authenticated'
 *               message: 'Authentication required to access this resource'
 *               timestamp: '2025-09-24T12:00:00.000Z'
 */
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
