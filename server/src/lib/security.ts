import helmet from "helmet";

// Helmet security middleware configuration
export const createHelmetMiddleware = (allowInsecure: boolean) => {
  return helmet({
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
    // Disable HSTS when ALLOW_INSECURE is true to allow HTTP traffic
    hsts: allowInsecure
      ? false
      : {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        },
  });
};
