// This file is deprecated - use config-new.ts instead
// Keeping for backward compatibility during transition
import appConfig from "./config-new";

// Map the new config structure to the old interface for backward compatibility
const legacyConfig = {
  NODE_ENV: appConfig.server.nodeEnv,
  PORT: appConfig.server.port,
  DATABASE_URL: appConfig.database.url,
  SESSION_SECRET: appConfig.auth.session.secret,
  LOG_LEVEL: appConfig.logging.level,
  PUBLIC_URL: appConfig.server.publicUrl,
  CONTAINER_CACHE_TTL: appConfig.docker.containerCacheTtl,
  CONTAINER_POLL_INTERVAL: appConfig.docker.containerPollInterval,
  AZURE_API_TIMEOUT: appConfig.azure.apiTimeout,
  CONNECTIVITY_CHECK_INTERVAL: appConfig.connectivity.checkInterval,
};

export type Config = typeof legacyConfig;

export default legacyConfig;
