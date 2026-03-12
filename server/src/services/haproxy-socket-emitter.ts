/**
 * HAProxy Socket Emitter
 *
 * Emits HAProxy backend/frontend list update notifications to Socket.IO clients
 * after mutations (create, update, delete). Follows the connectivity-socket-emitter pattern.
 */

import { Channel, ServerEvent } from "@mini-infra/types";
import { emitToChannel } from "../lib/socket";
import { servicesLogger } from "../lib/logger-factory";

const logger = servicesLogger();

/**
 * Emit HAProxy update notifications to subscribed clients.
 * Call this after any backend or frontend mutation.
 */
export function emitHAProxyUpdate(): void {
  try {
    emitToChannel(Channel.HAPROXY, ServerEvent.HAPROXY_BACKENDS_LIST, {
      count: -1, // Signal to invalidate; client will refetch
    });
    emitToChannel(Channel.HAPROXY, ServerEvent.HAPROXY_FRONTENDS_LIST, {
      count: -1,
    });

    logger.debug("Emitted haproxy:backends:list and haproxy:frontends:list via socket");
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : error },
      "Failed to emit HAProxy update via socket",
    );
  }
}
