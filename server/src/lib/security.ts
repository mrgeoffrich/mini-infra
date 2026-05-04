import helmet from "helmet";
import type { RequestHandler } from "express";
import { isHttpsOnlyEnabled, isForceInsecureOverride } from "./public-url-service";

// Builds a Helmet middleware. `httpsOnly` true → CSP upgrade-insecure-requests
// + HSTS + restricted connectSrc; false → permissive (allows HTTP fetches, no
// HSTS).
export const createHelmetMiddleware = (httpsOnly: boolean) => {
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
    formAction: ["'self'", "https://github.com"],
  };

  if (httpsOnly) {
    cspDirectives.upgradeInsecureRequests = [];
  } else {
    cspDirectives.connectSrc = ["'self'", "https:", "http:"];
    cspDirectives.upgradeInsecureRequests = null as unknown as [];
  }

  return helmet({
    contentSecurityPolicy: {
      directives: cspDirectives,
    },
    crossOriginEmbedderPolicy: false,
    hsts: httpsOnly
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        }
      : false,
  });
};

// Pre-builds both Helmet variants once and dispatches per request based on the
// cached `https_only_mode` setting. The `MINI_INFRA_FORCE_INSECURE` env var, if
// set, short-circuits to the permissive variant regardless of the DB row —
// recovery escape hatch when an HTTPS-only toggle has bricked an HTTP install.
export const createHelmetDispatcher = (): RequestHandler => {
  const strict = createHelmetMiddleware(true);
  const permissive = createHelmetMiddleware(false);

  return (req, res, next) => {
    if (isForceInsecureOverride()) {
      return permissive(req, res, next);
    }
    isHttpsOnlyEnabled()
      .then((httpsOnly) => (httpsOnly ? strict : permissive)(req, res, next))
      .catch(next);
  };
};
