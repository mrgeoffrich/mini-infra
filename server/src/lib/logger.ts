// Legacy logger file - maintained for backward compatibility
// The new logging architecture uses logger-factory.ts
import { appLogger } from "./logger-factory";

// Export the app logger as default for backward compatibility
const logger = appLogger();

export default logger;
