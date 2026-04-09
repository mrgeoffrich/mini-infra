// This file is deprecated - use config-new.ts instead
// Keeping for backward compatibility during transition
import appConfig from "./config-new";

// Map the new config structure to the old interface for backward compatibility
const legacyConfig = {
  NODE_ENV: appConfig.server.nodeEnv,
  PORT: appConfig.server.port,
  DATABASE_URL: appConfig.database.url,
  APP_SECRET: appConfig.auth.appSecret,
  LOG_LEVEL: appConfig.logging.level,
};

export type Config = typeof legacyConfig;

export default legacyConfig;
