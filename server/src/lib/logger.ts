import pino from "pino";
import config from "./config.js";

const logger = pino({
  level: config.LOG_LEVEL,

  // Environment-specific configuration
  ...(config.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "yyyy-mm-dd HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),

  // Production configuration with structured JSON output
  ...(config.NODE_ENV === "production"
    ? {
        formatters: {
          level: (label: string) => {
            return { level: label };
          },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        redact: {
          paths: [
            "password",
            "token",
            "accessToken",
            "refreshToken",
            "authorization",
            "cookie",
            "sessionToken",
            "*.password",
            "*.token",
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body.password",
            'res.headers["set-cookie"]',
          ],
          censor: "[REDACTED]",
        },
      }
    : {}),

  // Silent for test environment
  ...(config.NODE_ENV === "test" ? { level: "silent" } : {}),
});

export default logger;
