import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import prisma from "./prisma";
import { authConfig, serverConfig } from "./config-new";
import { appLogger } from "./logger-factory";
import type {
  GoogleOAuthProfile,
  PassportDoneCallback,
} from "@mini-infra/types";

const logger = appLogger();

/**
 * Dynamically configure (or reconfigure) the Google OAuth strategy.
 * Called by the /auth/google route with credentials from the DB.
 */
export function configureGoogleStrategy(
  clientId: string,
  clientSecret: string,
): void {
  passport.use(
    "google",
    new GoogleStrategy(
      {
        clientID: clientId,
        clientSecret: clientSecret,
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
          const email = profile.emails?.[0]?.value;
          const name = profile.displayName;
          const image = profile.photos?.[0]?.value;

          if (!email) {
            logger.error({ profile }, "No email found in Google profile");
            return done(new Error("No email found in Google profile"), null);
          }

          // Check ALLOWED_ADMIN_EMAILS if configured
          const allowedEmails = authConfig.allowedEmails;
          if (allowedEmails && allowedEmails.length > 0) {
            if (!allowedEmails.includes(email.toLowerCase())) {
              logger.warn(
                { email },
                "Login rejected - email not in ALLOWED_ADMIN_EMAILS list",
              );
              return done(new Error("Email not authorized"), null);
            }
          }

          // Find or create user
          let user = await prisma.user.findUnique({
            where: { googleId: profile.id },
          });

          if (!user) {
            // Check if user exists with same email
            user = await prisma.user.findUnique({
              where: { email: email.toLowerCase() },
            });

            if (user) {
              // Link existing local user to Google
              user = await prisma.user.update({
                where: { id: user.id },
                data: {
                  googleId: profile.id,
                  name: name || user.name,
                  image: image || user.image,
                  authMethod:
                    user.authMethod === "local" ? "both" : user.authMethod,
                  lastLoginAt: new Date(),
                },
              });
              logger.info(
                { userId: user.id, email },
                "Linked existing user account to Google",
              );
            } else {
              // Create new Google-only user
              user = await prisma.user.create({
                data: {
                  email: email.toLowerCase(),
                  name,
                  image,
                  googleId: profile.id,
                  authMethod: "google",
                  lastLoginAt: new Date(),
                },
              });
              logger.info(
                { userId: user.id, email },
                "Created new user from Google OAuth",
              );
            }
          } else {
            // Update existing Google user
            user = await prisma.user.update({
              where: { id: user.id },
              data: {
                name: name || user.name,
                image: image || user.image,
                email: email.toLowerCase() || user.email,
                lastLoginAt: new Date(),
              },
            });
          }

          return done(null, user);
        } catch (error) {
          logger.error({ error }, "Error processing Google OAuth callback");
          return done(error, null);
        }
      },
    ),
  );
}

// Serialization functions (needed even with JWT)
passport.serializeUser((user: any, done: PassportDoneCallback) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done: PassportDoneCallback) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

export default passport;
