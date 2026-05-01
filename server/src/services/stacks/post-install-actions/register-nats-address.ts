import { getLogger } from "../../../lib/logger-factory";
import { getNatsControlPlaneService } from "../../nats/nats-control-plane-service";
import type { PostInstallContext } from "./types";

const log = getLogger("stacks", "register-nats-address");

const NATS_SERVICE_NAME = "nats";
const NATS_CLIENT_PORT = 4222;
const NATS_MONITOR_PORT = 8222;

export async function registerNatsAddress(ctx: PostInstallContext): Promise<void> {
  const clientUrl = `nats://${ctx.projectName}-${NATS_SERVICE_NAME}:${NATS_CLIENT_PORT}`;
  const monitorUrl = `http://${ctx.projectName}-${NATS_SERVICE_NAME}:${NATS_MONITOR_PORT}`;

  await getNatsControlPlaneService(ctx.prisma).setManagedEndpoint({
    stackId: ctx.stackId,
    clientUrl,
    monitorUrl,
  });

  log.info({ clientUrl, monitorUrl, stackId: ctx.stackId }, "NATS address synced after stack apply");
}
