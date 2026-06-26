import type { PrismaClient } from "../../generated/prisma/client";
import type { StackContainerConfig } from "@mini-infra/types";
import { CloudflareService } from "./cloudflare-service";

/**
 * Resolves the `cloudflare-tunnel-token` dynamicEnv kind at apply time.
 *
 * The cloudflared connector needs the tunnel token issued when the managed
 * tunnel was created. Rather than baking that token into a stack parameter
 * (which couples the instantiate / create-tunnel / deploy steps to a rigid
 * order), the connector template declares the token as a dynamicEnv value;
 * this injector reads the live token from the managed-tunnel store on every
 * apply. cloudflared reads the resulting `TUNNEL_TOKEN` env var natively.
 *
 * Fails closed: if the stack is not environment-scoped, or no managed tunnel
 * exists for the environment, resolution throws so the apply aborts before a
 * cloudflared container is started with an empty token.
 */
export class CloudflareTunnelTokenInjector {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(
    environmentId: string | null,
    containerConfig: StackContainerConfig,
  ): Promise<Record<string, string> | null> {
    const dynamicEnv = containerConfig.dynamicEnv;
    if (!dynamicEnv) return null;

    const keys = Object.entries(dynamicEnv)
      .filter(([, src]) => src.kind === "cloudflare-tunnel-token")
      .map(([key]) => key);
    if (keys.length === 0) return null;

    if (!environmentId) {
      throw new Error(
        "Service declares cloudflare-tunnel-token but the stack has no environment — the cloudflare-tunnel connector must be environment-scoped",
      );
    }

    const cloudflare = new CloudflareService(this.prisma);
    const token = await cloudflare.getManagedTunnelToken(environmentId);
    if (!token) {
      throw new Error(
        `Service declares cloudflare-tunnel-token but no managed tunnel exists for environment ${environmentId} — create the managed tunnel before deploying the connector`,
      );
    }

    const values: Record<string, string> = {};
    for (const key of keys) values[key] = token;
    return values;
  }
}
