import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import prisma from "./prisma";
import config from "./config";
import logger from "./logger";
import type { GoogleOAuthProfile, PassportDoneCallback } from "@mini-infra/types";

// Configure Google OAuth2 strategy
if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        callbackURL: `${config.PUBLIC_URL || ""}/auth/google/callback`,
        scope: ["profile", "email"],
      },
      async (
        accessToken: string,
        refreshToken: string,
        profile: GoogleOAuthProfile,
        done: PassportDoneCallback,
      ) => {
        try {
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
} else {
  logger.warn("Google OAuth not configured - missing client ID or secret");
}

// Note: No session serialization needed - using JWT tokens for stateless authentication

export default passport;
