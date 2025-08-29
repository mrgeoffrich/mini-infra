import helmet from "helmet";
import rateLimit from "express-rate-limit";
import config from "./config";
import logger from "./logger";

// Helmet security middleware configuration
export const helmetMiddleware = helmet({
  // Configure Content Security Policy
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },

  // Configure other security headers
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
});

// Rate limiting middleware
export const rateLimitMiddleware = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_REQUESTS,
  message: {
    error: "Too many requests from this IP, please try again later.",
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    logger.warn(
      {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        path: req.path,
        method: req.method,
      },
      "Rate limit exceeded",
    );

    res.status(429).json({
      error: "Too many requests from this IP, please try again later.",
    });
  },
});

// Stricter rate limit for authentication endpoints
export const authRateLimitMiddleware = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 auth requests per windowMs
  message: {
    error: "Too many authentication attempts, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(
      {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        path: req.path,
        method: req.method,
      },
      "Auth rate limit exceeded",
    );

    res.status(429).json({
      error: "Too many authentication attempts, please try again later.",
    });
  },
});
