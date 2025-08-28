import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oidc";
import prisma from "./prisma.js";
import config from "./config.js";
import logger from "./logger.js";
import type {
  GoogleOAuthProfile,
  PassportDoneCallback,
} from "../types/auth.js";

// Configure Google OAuth2 strategy
if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback",
        scope: ["profile", "email"],
      },
      async (
        issuer: string,
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

// Serialize user for session storage
// eslint-disable-next-line @typescript-eslint/no-explicit-any
passport.serializeUser((user: any, done: (err: any, id?: any) => void) => {
  logger.debug({ userId: user.id }, "Serializing user for session");
  done(null, user.id);
});

// Deserialize user from session
passport.deserializeUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (userId: string, done: (err: any, user?: any) => void) => {
    try {
      logger.debug({ userId }, "Deserializing user from session");
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          image: true,
          createdAt: true,
        },
      });

      if (!user) {
        logger.warn({ userId }, "User not found during deserialization");
        return done(null, null);
      }

      done(null, user);
    } catch (error) {
      logger.error({ error, userId }, "Error deserializing user from session");
      done(error, null);
    }
  },
);

export default passport;
