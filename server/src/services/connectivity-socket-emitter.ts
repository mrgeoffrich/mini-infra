/**
 * Connectivity Socket Emitter
 *
 * Emits connectivity status updates to Socket.IO clients after each
 * scheduler health check cycle. Called once per cycle (every 5 min),
 * so no debounce is needed.
 */

import { Channel, ServerEvent } from "@mini-infra/types";
import type { ConnectivityStatusInfo } from "@mini-infra/types";
import { emitToChannel } from "../lib/socket";
import prisma from "../lib/prisma";
import { servicesLogger } from "../lib/logger-factory";

const logger = servicesLogger();

const NAV_SERVICES = ["docker", "cloudflare", "azure", "github-app"] as const;

type ConnectivityStatusRecord = {
  id: string;
  service: string;
  status: string;
  responseTimeMs: bigint | null;
  errorMessage: string | null;
  errorCode: string | null;
  lastSuccessfulAt: Date | null;
  checkedAt: Date;
  checkInitiatedBy: string | null;
  metadata: string | null;
};

function serializeConnectivityStatus(
  status: ConnectivityStatusRecord,
): ConnectivityStatusInfo {
  return {
    ...status,
    responseTimeMs: status.responseTimeMs
      ? Number(status.responseTimeMs)
      : null,
    lastSuccessfulAt: status.lastSuccessfulAt?.toISOString() || null,
    checkedAt: status.checkedAt.toISOString(),
  };
}

/**
 * Query the latest connectivity status for each nav service and emit via Socket.IO.
 */
export async function emitConnectivityStatus(): Promise<void> {
  const results = await Promise.all(
    NAV_SERVICES.map((service) =>
      prisma.connectivityStatus.findFirst({
        where: { service },
        orderBy: { checkedAt: "desc" },
      }),
    ),
  );

  const statuses: ConnectivityStatusInfo[] = results
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map(serializeConnectivityStatus);

  emitToChannel(Channel.CONNECTIVITY, ServerEvent.CONNECTIVITY_ALL, statuses);

  logger.debug(
    { count: statuses.length },
    "Emitted connectivity:all via socket",
  );
}
