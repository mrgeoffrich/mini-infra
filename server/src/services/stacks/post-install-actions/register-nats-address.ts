import { getLogger } from "../../../lib/logger-factory";
import { getNatsControlPlaneService } from "../../nats/nats-control-plane-service";
import type { PostInstallContext } from "./types";

const log = getLogger("stacks", "register-nats-address");

const NATS_SERVICE_NAME = "nats";
const NATS_CLIENT_PORT = 4222;
const NATS_MONITOR_PORT = 8222;
/**
 * Parameter name on the vault-nats template that maps the NATS client port
 * to the host. Must stay in sync with `server/templates/vault-nats/template.json`.
 * Pinned as a const so a typo is a compile-time error rather than a silent
 * fallback to the default port.
 */
const NATS_HOST_PORT_PARAM = "nats-host-port";

export async function registerNatsAddress(ctx: PostInstallContext): Promise<void> {
  const clientUrl = `nats://${ctx.projectName}-${NATS_SERVICE_NAME}:${NATS_CLIENT_PORT}`;
  const monitorUrl = `http://${ctx.projectName}-${NATS_SERVICE_NAME}:${NATS_MONITOR_PORT}`;

  // Host-loopback URL for `network_mode: host` services (egress-fw-agent
  // ALT-27, the egress-gateway in Phase 3). The vault-nats stack maps the
  // NATS client port to the host via the `nats-host-port` parameter; we
  // read whatever the operator chose so a non-default port still works.
  const hostPortRaw = ctx.parameterValues[NATS_HOST_PORT_PARAM];
  let clientHostUrl: string | undefined;
  if (typeof hostPortRaw === "number" && Number.isInteger(hostPortRaw) && hostPortRaw > 0 && hostPortRaw < 65_536) {
    clientHostUrl = `nats://127.0.0.1:${hostPortRaw}`;
  } else if (typeof hostPortRaw === "string" && /^[0-9]+$/.test(hostPortRaw)) {
    const n = Number(hostPortRaw);
    if (n > 0 && n < 65_536) clientHostUrl = `nats://127.0.0.1:${n}`;
  }
  if (!clientHostUrl) {
    log.warn(
      { hostPortRaw, paramName: NATS_HOST_PORT_PARAM },
      "vault-nats parameter for host port missing or invalid; clientHostUrl will fall back to NatsState default at read time",
    );
  }

  await getNatsControlPlaneService(ctx.prisma).setManagedEndpoint({
    stackId: ctx.stackId,
    clientUrl,
    monitorUrl,
    clientHostUrl,
  });

  log.info({ clientUrl, monitorUrl, clientHostUrl, stackId: ctx.stackId }, "NATS address synced after stack apply");
}
