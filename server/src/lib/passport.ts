import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import prisma from "./prisma";
import { authConfig, serverConfig } from "./config-new";
import { appLogger } from "./logger-factory";

const logger = appLogger();
import type {
  GoogleOAuthProfile,
  PassportDoneCallback,
} from "@mini-infra/types";

// Configure Google OAuth2 strategy - always register but handle missing credentials
const googleClientId =
  authConfig.google.clientId ||
  process.env.GOOGLE_CLIENT_ID ||
  "not-configured";
const googleClientSecret =
  authConfig.google.clientSecret ||
  process.env.GOOGLE_CLIENT_SECRET ||
  "not-configured";

passport.use(
  "google",
  new GoogleStrategy(
    {
      clientID: googleClientId,
      clientSecret: googleClientSecret,
      callbackURL: `${serverConfig.publicUrl || ""}/auth/google/callback`,
      scope: ["profile", "email"],
    },
    async (
      accessToken: string,
      refreshToken: string,
      profile: GoogleOAuthProfile,
      done: PassportDoneCallback,
    ) => {
      try {
        // Check if credentials are properly configured
        if (
          googleClientId === "not-configured" ||
          googleClientSecret === "not-configured"
        ) {
          logger.error(
            "Google OAuth not properly configured - missing client ID or secret",
          );
          return done(new Error("Google OAuth not configured"), null);
        }

        logger.info(
          { googleId: profile.id },
          "Processing Google OAuth callback",
        );

        // Extract user information from Google profile
        const email = profile.emails?.[0]?.value;
        const name = profile.displayName;
        const image = profile.photos?.[0]?.value;

        if (!email) {
          logger.error({ profile }, "No email found in Google profile");
          return done(new Error("No email found in Google profile"), null);
        }

        // Check if user's email is in the allowed list
        const allowedEmails = authConfig.allowedEmails;
        if (!allowedEmails || allowedEmails.length === 0) {
          logger.error(
            "Login rejected - ALLOWED_ADMIN_EMAILS is not configured",
          );
          return done(
            new Error("ALLOWED_ADMIN_EMAILS must be configured"),
            null,
          );
        }
        if (!allowedEmails.includes(email.toLowerCase())) {
          logger.warn(
            { email },
            "Login rejected - email not in ALLOWED_ADMIN_EMAILS list",
          );
          return done(new Error("Email not authorized"), null);
        }

        // Find or create user in database
        let user = await prisma.user.findUnique({
          where: { googleId: profile.id },
        });

        if (!user) {
          // Check if user exists with same email but no googleId
          user = await prisma.user.findUnique({
            where: { email },
          });

          if (user) {
            // Link existing user account to Google
            user = await prisma.user.update({
              where: { id: user.id },
              data: {
                googleId: profile.id,
                name: name || user.name,
                image: image || user.image,
              },
            });
            logger.info(
              { userId: user.id, email },
              "Linked existing user account to Google",
            );
          } else {
            // Create new user
            user = await prisma.user.create({
              data: {
                email,
                name,
                image,
                googleId: profile.id,
              },
            });
            logger.info(
              { userId: user.id, email },
              "Created new user from Google OAuth",
            );
          }
        } else {
          // Update existing user information
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              name: name || user.name,
              image: image || user.image,
              email: email || user.email,
            },
          });
          logger.info(
            { userId: user.id, email },
            "Updated existing user from Google OAuth",
          );
        }

        return done(null, user);
      } catch (error) {
        logger.error({ error }, "Error processing Google OAuth callback");
        return done(error, null);
      }
    },
  ),
);

// Log configuration status
if (
  googleClientId === "not-configured" ||
  googleClientSecret === "not-configured"
) {
  logger.warn("Google OAuth not configured - missing client ID or secret");
} else {
  logger.info("Google OAuth strategy registered successfully");
}

if (authConfig.allowedEmails && authConfig.allowedEmails.length > 0) {
  logger.info(
    { count: authConfig.allowedEmails.length },
    "Admin email allowlist is active - only specified emails can log in",
  );
} else {
  logger.error(
    "ALLOWED_ADMIN_EMAILS is not set - all Google OAuth logins will be rejected",
  );
}

// Serialization functions (needed for testing even if using JWT for production)
passport.serializeUser((user: any, done: PassportDoneCallback) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done: PassportDoneCallback) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id },
    });
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

export default passport;
