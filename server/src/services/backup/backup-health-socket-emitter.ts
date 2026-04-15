/**
 * Backup Health Socket Emitter
 *
 * Emits backup health status updates to Socket.IO clients after
 * backup completion or configuration changes.
 */

import { Channel, ServerEvent } from "@mini-infra/types";
import { emitToChannel } from "../../lib/socket";
import { getLogger } from "../../lib/logger-factory";
import { calculateBackupHealth } from "./backup-health-calculator";

const logger = getLogger("backup", "backup-health-socket-emitter");

/**
 * Calculate and emit the current backup health status via Socket.IO.
 */
export async function emitBackupHealthStatus(): Promise<void> {
  const healthStatus = await calculateBackupHealth();

  emitToChannel(
    Channel.BACKUP_HEALTH,
    ServerEvent.BACKUP_HEALTH_STATUS,
    healthStatus,
  );

  logger.debug(
    { status: healthStatus.status },
    "Emitted backup-health:status via socket",
  );
}
