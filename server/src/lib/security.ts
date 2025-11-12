import helmet from "helmet";

// Helmet security middleware configuration
export const createHelmetMiddleware = (allowInsecure: boolean) => {
  // Base CSP directives
  const cspDirectives: Record<string, string[]> = {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", "https:"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'", "https:"],
    fontSrc: ["'self'", "https:", "data:"],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'"],
    frameSrc: ["'none'"],
  };

  // Allow HTTP connections when insecure mode is enabled
  if (allowInsecure) {
    // Add http: to allowed sources for API calls
    cspDirectives.connectSrc = ["'self'", "https:", "http:"];
    // Don't add upgradeInsecureRequests when allowing insecure connections
  } else {
    // Force HTTPS upgrades in production/secure mode
    cspDirectives.upgradeInsecureRequests = [];
  }

  return helmet({
    // Configure Content Security Policy
    contentSecurityPolicy: {
      directives: cspDirectives,
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
